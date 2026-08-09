// The relic-driven board-mutation path, end to end: a cursed relic collapses
// the live board, the run is persisted, the run is loaded again, and both the
// tile positions and the win and loss verdicts are still correct at the edge
// length the load reconciled to.
//
// AAP validation gate V6 row 4, and the prompt edge case stated at AAP 0.1.2.5:
// "board-size-altering cursed relics (e.g. shrink board) must not corrupt
// existing tile positions or win/lose check" — across a reload.
//
// SCOPE. tests/unit/relics/risk-reward-cursed.test.ts owns the relic's own
// declaration and its immediate in-memory shrink mechanics.
// tests/unit/run/run-state-store.test.ts owns the general version and
// corruption policy, and tests/unit/run/run-relic-board-size.test.ts owns the
// controller-driven load path over hand-written envelopes. This file owns the
// intersection those three leave: collapse, persist, load, reconcile, verdict.
//
// THREE EDGE LENGTHS are in play after a reload — the one the snapshot
// recorded, the one the rules configuration declares, and the one the
// reconciliation applied. Section 4 constructs a board on which all three
// yield DIFFERENT verdict pairs, and asserts the terminal-state evaluation
// reads the third.
//
// Mechanical provenance, from the deleted vanilla sources:
//   js/game_manager.js L36-L45           setup()'s rehydration branch, which
//                                        rebuilt the grid from the SAVED size
//                                        at L40-L41, `new Grid(
//                                        previousState.grid.size,
//                                        previousState.grid.cells)`, with
//                                        nothing reconciling that size against
//                                        the configuration
//                                        -> src/run/run-state-store.ts
//   js/game_manager.js L238-L268         movesAvailable() and
//                                        tileMatchesAvailable(), the neighbour
//                                        scan bounded by `this.size`
//                                        -> src/engine/terminal-state.ts
//   js/game_manager.js L102-L110         serialize(), the outermost stage of
//                                        the persisted three-stage snapshot
//   js/grid.js         L102-L117         the middle stage, an empty cell kept
//                                        as `null`
//   js/tile.js         L19-L27           the innermost stage
//   js/grid.js         L80-L86           cellContent() yields `null` for a cell
//                                        outside the lattice rather than
//                                        raising
//   js/grid.js         L89-L91           insertTile() indexes
//                                        cells[tile.x][tile.y]
//   js/tile.js         L10-L17           savePosition() copies the current
//                                        cell; updatePosition() writes the
//                                        current cell alone
//   js/local_storage_manager.js L1-L19   the in-memory store double this suite
//                                        injects
//   js/local_storage_manager.js L22      the best-score key literal
//   js/local_storage_manager.js L43-L45  getBestScore() yields the stored
//                                        string when a value is present and
//                                        the number 0 when none is
//   js/local_storage_manager.js L52-L55  getGameState() called JSON.parse with
//                                        no guard -> src/storage/**
//   js/application.js  L3                the board dimension as a literal
//                                        argument, one of its three vanilla
//                                        declaration sites, the other two being
//                                        style/main.scss L6 and the sixteen
//                                        cells of index.html L43-L68
//                                        -> src/config/**
//
// CONTRIBUTING.md lists a change to the grid size among the changes that might
// not be accepted; the supersession entry is in docs/DECISION_LOG.md.
//
// Named figures: Figure 4, "Turn Data Flow: From Keystroke to Composited Frame
// and Persisted Run State", in docs/architecture/data-flow.md, whose
// `Moves available?` decision and `Run state written under namespaced key` node
// are the two ends of the path asserted here; and Figure 7, "Seeded
// Determinism: One Run Seed Fanned into Named RNG Substreams", whose persisted
// cursor nodes the `rngCursor` cases exercise.
//
// Every reporter reaches its subject by injection. Nothing here reads a
// document, a clock, the global random source or a real Web Storage, and
// nothing here imports src/observability. Decisions behind this file are
// recorded in docs/DECISION_LOG.md.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import {
  createDefaultStageConfig,
  stageGoalForIndex,
} from '../../../src/config/stage-config';
import { Grid } from '../../../src/engine/grid';
import { createHookBus } from '../../../src/engine/hook-bus';
import type { HookBus } from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  HookContext,
  HookSubscription,
  StageEndPayload,
} from '../../../src/engine/hooks';
import {
  hasReachedWinValue,
  highestTileValue,
  movesAvailable,
  tileMatchesAvailable,
} from '../../../src/engine/terminal-state';
import { Tile } from '../../../src/engine/tile';
import { NOOP_ENGINE_REPORTER } from '../../../src/engine/types';
import type {
  SerializedGameState,
  SerializedGrid,
} from '../../../src/engine/types';
import { RISK_REWARD_CURSED_FAMILY } from '../../../src/relics/families/risk-reward-cursed';
import {
  RelicRegistry,
  findRelicById,
} from '../../../src/relics/relic-registry';
import type { ActiveRelic, Relic } from '../../../src/relics/relic-types';
import { createRngStreams } from '../../../src/rng/rng-streams';
import type {
  RngCursorMap,
  RngStreams,
  StreamName,
} from '../../../src/rng/rng-streams';
import {
  RUN_STATE_SCHEMA_VERSION,
  createFreshRunState,
  runCorrelationId,
} from '../../../src/run/run-state';
import type {
  LegacyBoardSnapshot,
  PersistedRelic,
  RunReporter,
  RunState,
} from '../../../src/run/run-state';
import {
  RunStateStore,
  reconcileBoardSize,
} from '../../../src/run/run-state-store';
import type {
  BoardSizeReconciliation,
  RunStateLoadResult,
} from '../../../src/run/run-state-store';
import { LocalStorageManager } from '../../../src/storage/local-storage-manager';
import type { StorageReporter } from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import type { StorageLike } from '../../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  GAME_STATE_KEY,
  OWNED_STORAGE_KEYS,
  RUN_STATE_KEY,
} from '../../../src/storage/storage-keys';
import type { OwnedStorageKey } from '../../../src/storage/storage-keys';
import {
  copyBoard,
  createEmptyBoard,
  createNearLossBoard,
} from '../../fixtures/boards';

/* ==========================================================================
 * 1. Harness
 * ========================================================================== */

/** Seed every substream in this suite is derived from. */
const RUN_SEED = 'board-mutation-seed';

/** Run instance the envelopes carry. */
const RUN_ID = 'board-mutation-run';

/**
 * Correlation identifier every injected reporter is asserted against, derived
 * through the canonical derivation `runCorrelationId` publishes.
 */
const CORRELATION_ID = runCorrelationId(RUN_SEED, RUN_ID);

/** The board-mutating relic under test. */
const CURSED_ID = 'collapsing-vault';

/** The relic whose own state slot survives the envelope, held second. */
const BANKING_ID = 'hollow-ascension';

/** Edge length one collapse leaves a default board at. */
const COLLAPSED_SIZE = 3;

/** Edge length the wide saved snapshot of section 4 records. */
const WIDE_SIZE = 5;

/** Stage index every envelope records. */
const STAGE_INDEX = 1;

/** Score every stage-end dispatch carries. */
const STAGE_SCORE = 240;

/** Score contribution every merge dispatch carries. */
const MERGE_SCORE_DELTA = 4;

/** Face value every merge dispatch produces. */
const MERGE_RESULT_VALUE = 4;

/** Merges dispatched before the banking relic's slot is persisted. */
const BANKED_MERGES = 3;

/** Points the banking relic adds per banked charge. */
const BANK_BONUS_PER_CHARGE = 4;

/** Face values the ladder fills a region with, in index order. */
const LADDER: readonly number[] = [2, 4, 8, 16, 32];

/**
 * Index step the ladder advances per row. Coprime with the ladder length, so
 * no two cells sharing an edge carry one value and no pair in a
 * ladder-filled region can merge.
 */
const LADDER_ROW_STEP = 3;

/** Face value the win check is asserted against. */
const WIN_TILE_VALUE = 2048;

/** Best score seeded before a save and load cycle, as its stored text. */
const SEEDED_BEST_SCORE = '31337';

/** One reconciliation as the injected `RunReporter` received it. */
interface ReconciliationRecord {
  readonly correlationId: string;
  readonly savedSize: number;
  readonly configuredSize: number;
  readonly relicSize: number;
  readonly appliedSize: number;
}

/**
 * One refused load as the injected `RunReporter` received it. The correlation
 * identifier is optional on the report, and absent on a store constructed
 * without one.
 */
interface CorruptionRecord {
  readonly correlationId: string | undefined;
  readonly key: string;
  readonly problems: readonly string[];
}

/** One cell holding a tile, as the assertions read a lattice. */
interface Occupant {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/** One dispatch as a handler's own context described it. */
interface DispatchRecord {
  readonly correlationId: string;
  readonly hook: string;
  readonly subscriberId: string;
  readonly pickupOrder: number;
  readonly boardSize: number;
}

/** One held relic projected to the members a round trip must preserve. */
interface HeldProjection {
  readonly id: string;
  readonly pickupOrder: number;
  readonly charges: number | undefined;
  readonly state: unknown;
}

/**
 * Everything one test is given, rebuilt in full before each test.
 *
 * `config` and `grid` are reassignable: a collapse writes both `grid.size` and
 * `config.boardSize`, and several cases replace the lattice with a fixture
 * board before dispatching.
 */
interface Bench {
  config: RulesConfig;
  grid: Grid;
  readonly backing: MemoryStorage;
  readonly manager: LocalStorageManager;
  readonly store: RunStateStore;
  readonly registry: RelicRegistry;
  readonly bus: HookBus;
  readonly streams: RngStreams;
  readonly reporter: RunReporter;
  readonly reconciled: ReconciliationRecord[];
  readonly corrupted: CorruptionRecord[];
  readonly writeFailures: string[];
  readonly storageFailures: string[];
}

let bench: Bench;

beforeEach(() => {
  const config = createDefaultRulesConfig();
  const backing = new MemoryStorage();
  const reconciled: ReconciliationRecord[] = [];
  const corrupted: CorruptionRecord[] = [];
  const writeFailures: string[] = [];
  const storageFailures: string[] = [];

  const storageReporter: StorageReporter = {
    onFailure(failure): void {
      storageFailures.push(`${failure.operation}:${failure.key}`);
    },
  };

  const reporter: RunReporter = {
    onBoardSizeReconciled(report): void {
      reconciled.push({
        correlationId: report.correlationId,
        savedSize: report.savedSize,
        configuredSize: report.configuredSize,
        relicSize: report.relicSize,
        appliedSize: report.appliedSize,
      });
    },

    onLoadCorrupted(report): void {
      corrupted.push({
        correlationId: report.correlationId,
        key: report.key,
        problems: report.problems,
      });
    },

    onWriteFailed(report): void {
      writeFailures.push(report.key);
    },
  };

  const manager = new LocalStorageManager({
    storage: backing,
    reporter: storageReporter,
  });
  const bus = createHookBus({
    correlationId: CORRELATION_ID,
    reporter: NOOP_ENGINE_REPORTER,
  });

  bench = {
    config,
    grid: new Grid(config.boardSize),
    backing,
    manager,
    store: new RunStateStore({
      storage: manager,
      config,
      reporter,
      correlationId: CORRELATION_ID,
    }),
    registry: new RelicRegistry({
      bus,
      reporter: NOOP_ENGINE_REPORTER,
      correlationId: CORRELATION_ID,
    }),
    bus,
    streams: createRngStreams(RUN_SEED),
    reporter,
    reconciled,
    corrupted,
    writeFailures,
    storageFailures,
  };
});

// MANDATORY TEARDOWN. The application removes the best score on no path, so
// every key the product owns is removed here, read off the exported list rather
// than written out as literals.
afterEach(() => {
  for (const key of OWNED_STORAGE_KEYS) {
    bench.backing.removeItem(key);
  }
});

/**
 * Reads one relic declaration out of the family module under test.
 *
 * @param id Identifier to resolve.
 * @returns The declaration.
 */
function relicFromFamily(id: string): Relic {
  const found = RISK_REWARD_CURSED_FAMILY.relics.find(
    (relic): boolean => relic.id === id,
  );

  expect(found, `${id} is declared by the cursed family`).toBeDefined();

  return found as Relic;
}

/**
 * Reads the source text of one relic's handler for a hook it binds.
 *
 * @param id Identifier of the relic.
 * @returns The handler's own source text.
 */
function stageEndHandlerSource(id: string): string {
  const relic = findRelicById(id);

  expect(relic, `${id} is in the catalogue`).toBeDefined();

  const handler = relic?.hooks.onStageEnd;

  expect(typeof handler).toBe('function');

  return String(handler);
}

/** Writes one tile into the lattice through its public insertion path. */
function place(grid: Grid, x: number, y: number, value: number): void {
  grid.insertTile(new Tile({ x, y }, value));
}

/**
 * Reads every occupied cell, x-outer and y-inner.
 *
 * @param grid Lattice to walk.
 * @returns The occupants in scan order.
 */
function occupants(grid: Grid): Occupant[] {
  const found: Occupant[] = [];

  grid.eachCell((x, y, tile) => {
    if (tile) {
      found.push({ x, y, value: tile.value });
    }
  });

  return found;
}

/**
 * Asserts a lattice is internally coherent: every occupant lies inside the
 * bounds its own size declares, every occupant's coordinates name the cell
 * holding it, and no cell is named twice.
 *
 * @param grid Lattice to check.
 */
function expectCoherentLattice(grid: Grid): void {
  const addressed = new Set<string>();

  for (let x = 0; x < grid.size; x += 1) {
    for (let y = 0; y < grid.size; y += 1) {
      const tile = grid.cells[x][y];

      if (tile === null) {
        continue;
      }

      expect(grid.withinBounds({ x: tile.x, y: tile.y })).toBe(true);
      expect([tile.x, tile.y]).toEqual([x, y]);
      expect(grid.cellContent({ x, y })).toBe(tile);
      addressed.add(`${String(x)},${String(y)}`);
    }
  }

  expect(addressed.size).toBe(occupants(grid).length);
}

/**
 * Copies a serialised grid the way storage does, through text.
 *
 * @param snapshot Snapshot to copy.
 * @returns A snapshot sharing no object with the argument.
 */
function throughText(snapshot: SerializedGrid): SerializedGrid {
  return JSON.parse(JSON.stringify(snapshot)) as SerializedGrid;
}

/**
 * Builds the lattice a board fixture describes. `Grid.fromState` reads
 * `state[x][y]`, so the cell matrix is what a restore takes.
 *
 * @param board Fixture board to rebuild.
 * @returns A lattice at the fixture's own size.
 */
function gridFromBoard(board: SerializedGameState): Grid {
  return new Grid(board.grid.size, board.grid.cells);
}

/**
 * Builds a lattice of `size` whose top-left `filled` by `filled` region is a
 * ladder fill, with the win value in the region's far corner.
 *
 * No two cells sharing an edge inside the region carry one value, so the
 * region admits no merge; every cell outside it stands empty.
 *
 * @param size Edge length of the lattice.
 * @param filled Edge length of the filled region.
 * @returns The lattice.
 */
function ladderGrid(size: number, filled: number): Grid {
  const grid = gridFromBoard(createEmptyBoard(size));
  const corner = filled - 1;

  for (let x = 0; x < filled; x += 1) {
    for (let y = 0; y < filled; y += 1) {
      if (x === corner && y === corner) {
        continue;
      }

      place(grid, x, y, LADDER[(x + LADDER_ROW_STEP * y) % LADDER.length]);
    }
  }

  place(grid, corner, corner, WIN_TILE_VALUE);

  return grid;
}


/**
 * Takes one relic on for the run through the registry, which registers its
 * handler table with the bus at the next pickup position.
 *
 * @param id Identifier to take on.
 */
function pickUp(id: string): void {
  expect(bench.registry.pickUp(id), `${id} is taken on`).toBeDefined();
}

/**
 * Dispatches `onStageEnd` over the bench's live board and rules.
 *
 * @param cleared Whether the stage was cleared.
 * @returns The payload the dispatch resolved to.
 */
function endStage(cleared: boolean): StageEndPayload {
  return bench.bus.dispatch(
    'onStageEnd',
    { stageIndex: STAGE_INDEX, cleared, score: STAGE_SCORE },
    { config: bench.config, rng: bench.streams, grid: bench.grid },
  ).payload;
}

/**
 * Dispatches one merge over the bench, with two tiles that stand outside the
 * lattice, so nothing on the board is read or written by the dispatch itself.
 *
 * @returns The score contribution the dispatch resolved to.
 */
function resolveMerge(): number {
  return bench.bus.dispatch(
    'onMerge',
    {
      source: new Tile({ x: 1, y: 0 }, 2),
      target: new Tile({ x: 0, y: 0 }, 2),
      resultValue: MERGE_RESULT_VALUE,
      scoreDelta: MERGE_SCORE_DELTA,
    },
    { config: bench.config, rng: bench.streams, grid: bench.grid },
  ).payload.scoreDelta;
}

/**
 * Reads one substream's draw count.
 *
 * @param name Substream to read.
 * @returns Draws consumed from it.
 */
function cursorOf(name: StreamName): number {
  return bench.streams.snapshotCursors()[name];
}

/**
 * Reads a raw stored value, normalising the `undefined` an in-memory store
 * yields for an absent key to the `null` a real Web Storage yields.
 *
 * @param store Store to read.
 * @param key Key to read.
 * @returns The stored text, or `null`.
 */
function rawValue(store: StorageLike, key: OwnedStorageKey): string | null {
  return store.getItem(key) ?? null;
}

/**
 * Projects the held relics to the members a save and restore must preserve, in
 * pickup order.
 *
 * @param held Held relics as the registry reports them.
 * @returns One projection per relic.
 */
function projectHeld(held: readonly ActiveRelic[]): HeldProjection[] {
  return held.map((relic) => ({
    id: relic.definition.id,
    pickupOrder: relic.pickupOrder,
    charges: relic.charges,
    state: relic.state,
  }));
}

/**
 * Wraps a board snapshot and the relic entries in a versioned envelope.
 *
 * The board member carries the serialised board VERBATIM: AAP Contract 5 wraps
 * the vanilla snapshot rather than reshaping it.
 *
 * @param grid Board snapshot to wrap.
 * @param relics Relic entries, in pickup order.
 * @param cursors Draw counts to record.
 * @returns The envelope.
 */
function envelopeFor(
  grid: SerializedGrid,
  relics: readonly PersistedRelic[],
  cursors: RngCursorMap,
): RunState {
  const board: LegacyBoardSnapshot = {
    grid,
    score: STAGE_SCORE,
    over: false,
    won: false,
    keepPlaying: false,
  };
  const fresh = createFreshRunState({
    runId: RUN_ID,
    seed: RUN_SEED,
    rngCursor: cursors,
    stageIndex: STAGE_INDEX,
    stageGoal: stageGoalForIndex(STAGE_INDEX, createDefaultStageConfig()),
    board,
  });

  return { ...fresh, relics };
}

/**
 * Builds a second store over the bench's own persistence and reporter, at a
 * configuration declaring `size`.
 *
 * @param size Edge length the store's configuration declares.
 * @returns The store.
 */
function storeConfiguredAt(size: number): RunStateStore {
  const configured = createDefaultRulesConfig();

  configured.boardSize = size;

  return new RunStateStore({
    storage: bench.manager,
    config: configured,
    reporter: bench.reporter,
    correlationId: CORRELATION_ID,
  });
}

/**
 * Reads the envelope a load resolved, asserting first that one was resolved.
 *
 * @param loaded Result to read.
 * @returns The envelope.
 */
function requireState(loaded: RunStateLoadResult): RunState {
  expect(loaded.state, `outcome ${loaded.outcome} resolved an envelope`)
    .not.toBeNull();

  return loaded.state as RunState;
}

/** What one whole collapse, persist and reload sequence produced. */
interface SequenceResult {
  readonly board: SerializedGrid;
  readonly cursors: RngCursorMap;
  readonly relics: readonly PersistedRelic[];
  readonly applied: number;
  readonly outcome: string;
}

/**
 * Runs the whole path once over collaborators built from scratch: collapse the
 * board, project the relics, persist the envelope, load it, and read what the
 * load resolved. Every owned key is removed before returning.
 *
 * @param seed Run seed the substreams are derived from.
 * @returns What the sequence produced.
 */
function runSequence(seed: string): SequenceResult {
  const config = createDefaultRulesConfig();
  const backing = new MemoryStorage();
  const manager = new LocalStorageManager({ storage: backing });
  const store = new RunStateStore({
    storage: manager,
    config,
    correlationId: CORRELATION_ID,
  });
  const streams = createRngStreams(seed);
  const bus = createHookBus({
    correlationId: CORRELATION_ID,
    reporter: NOOP_ENGINE_REPORTER,
  });
  const registry = new RelicRegistry({
    bus,
    reporter: NOOP_ENGINE_REPORTER,
    correlationId: CORRELATION_ID,
  });
  const grid = new Grid(config.boardSize);

  place(grid, 0, 0, 2);
  place(grid, 1, 2, 8);
  place(grid, 3, 0, 16);
  place(grid, 0, 3, 32);
  place(grid, 3, 3, 4);
  expect(registry.pickUp(CURSED_ID)).toBeDefined();
  bus.dispatch(
    'onStageEnd',
    { stageIndex: STAGE_INDEX, cleared: true, score: STAGE_SCORE },
    { config, rng: streams, grid },
  );

  const relics = registry.serialize();
  const cursors = streams.snapshotCursors();

  expect(store.save(envelopeFor(grid.serialize(), relics, cursors))).toBe(true);

  const loaded = store.load();
  const state = requireState(loaded);

  for (const key of OWNED_STORAGE_KEYS) {
    backing.removeItem(key);
  }

  return {
    board: state.board.grid,
    cursors: state.rngCursor,
    relics,
    applied: loaded.reconciliation?.appliedSize ?? 0,
    outcome: loaded.outcome,
  };
}


/* ==========================================================================
 * 2. The collapse in memory: positions, and the verdicts at the new size
 *
 * The relic's own declaration and its re-homing mechanics belong to
 * tests/unit/relics/risk-reward-cursed.test.ts. What is asserted here is only
 * what the reload half needs as its precondition.
 * ========================================================================== */

describe('a stage cleared under the cursed relic', () => {
  it('moves the lattice and the configured edge length together', () => {
    place(bench.grid, 0, 0, 2);
    place(bench.grid, 1, 2, 8);
    place(bench.grid, 3, 0, 16);
    place(bench.grid, 0, 3, 32);
    place(bench.grid, 3, 3, 4);
    pickUp(CURSED_ID);
    endStage(true);

    expect(bench.grid.size).toBe(COLLAPSED_SIZE);
    expect(bench.config.boardSize).toBe(COLLAPSED_SIZE);
    expect(bench.grid.size).toBe(bench.config.boardSize);
  });

  it('registers the relic as one stage-end subscriber at pickup order 0', () => {
    pickUp(CURSED_ID);

    const bound: readonly HookSubscription<'onStageEnd'>[] =
      bench.bus.subscriptions('onStageEnd');

    expect(bound).toHaveLength(1);
    expect(bound[0].subscriberId).toBe(CURSED_ID);
    expect(bound[0].pickupOrder).toBe(0);
    expect(bound[0].charges).toBeUndefined();
    expect(bench.bus.degraded()).toEqual([]);
  });

  it('hands each stage-end handler the run correlation identifier', () => {
    place(bench.grid, 0, 0, 2);
    pickUp(CURSED_ID);

    const observed: DispatchRecord[] = [];

    expect(
      bench.bus.register({
        id: 'board-mutation-observer',
        hooks: {
          onStageEnd: (_payload, context: HookContext): void => {
            observed.push({
              correlationId: context.correlationId,
              hook: context.hook,
              subscriberId: context.subscriberId,
              pickupOrder: context.pickupOrder,
              boardSize: context.config.boardSize,
            });
          },
        },
      }),
    ).toBe(true);
    endStage(true);

    expect(observed).toEqual([
      {
        correlationId: CORRELATION_ID,
        hook: 'onStageEnd',
        subscriberId: 'board-mutation-observer',
        pickupOrder: 1,

        // The rules are projected per handler, so the observer dispatched after
        // the relic reads the edge length the relic's own commands wrote.
        boardSize: COLLAPSED_SIZE,
      },
    ]);
    expect(bench.grid.size).toBe(COLLAPSED_SIZE);
  });

  it('leaves every tile already inside the new bound at its own cell', () => {
    place(bench.grid, 0, 0, 2);
    place(bench.grid, 1, 2, 8);
    place(bench.grid, 3, 0, 16);
    place(bench.grid, 0, 3, 32);
    place(bench.grid, 3, 3, 4);
    pickUp(CURSED_ID);
    endStage(true);

    expect(occupants(bench.grid)).toContainEqual({ x: 0, y: 0, value: 2 });
    expect(occupants(bench.grid)).toContainEqual({ x: 1, y: 2, value: 8 });
  });

  it('keeps every survivor in bounds, in one cell, agreeing with its slot', () => {
    place(bench.grid, 0, 0, 2);
    place(bench.grid, 1, 2, 8);
    place(bench.grid, 3, 0, 16);
    place(bench.grid, 0, 3, 32);
    place(bench.grid, 3, 3, 4);
    pickUp(CURSED_ID);
    endStage(true);

    const survivors = occupants(bench.grid);

    expect(survivors).toHaveLength(5);
    expect(survivors.map((cell) => cell.value).sort((a, b) => a - b)).toEqual([
      2, 4, 8, 16, 32,
    ]);
    expectCoherentLattice(bench.grid);
  });

  it('re-homes through updatePosition, which leaves the saved cell alone', () => {
    place(bench.grid, 0, 0, 2);
    place(bench.grid, 3, 3, 4);

    const kept = bench.grid.cellContent({ x: 0, y: 0 });
    const exile = bench.grid.cellContent({ x: 3, y: 3 });

    expect(kept).not.toBeNull();
    expect(exile).not.toBeNull();
    exile?.savePosition();
    pickUp(CURSED_ID);
    endStage(true);

    // The cell `savePosition()` recorded is unchanged, and the tile now stands
    // somewhere else: `updatePosition()` writes the current cell alone.
    expect(exile?.previousPosition).toEqual({ x: 3, y: 3 });
    expect([exile?.x, exile?.y]).not.toEqual([3, 3]);
    expect(bench.grid.withinBounds({ x: exile?.x ?? -1, y: exile?.y ?? -1 }))
      .toBe(true);

    // A tile the collapse never moved recorded no previous cell.
    expect(kept?.previousPosition).toBeNull();
    expect([kept?.x, kept?.y]).toEqual([0, 0]);
  });

  it('serialises the collapsed lattice back to a square matrix of its size', () => {
    place(bench.grid, 0, 0, 2);
    place(bench.grid, 3, 3, 4);
    pickUp(CURSED_ID);
    endStage(true);

    const snapshot = bench.grid.serialize();

    expect(snapshot.size).toBe(COLLAPSED_SIZE);
    expect(snapshot.cells).toHaveLength(COLLAPSED_SIZE);

    for (const column of snapshot.cells) {
      expect(column).toHaveLength(COLLAPSED_SIZE);
    }

    // A round trip through the restore path reproduces the same lattice.
    const rebuilt = new Grid(snapshot.size, throughText(snapshot).cells);

    expect(rebuilt.serialize()).toEqual(snapshot);
    expect(occupants(rebuilt)).toEqual(occupants(bench.grid));
  });

  it('records the collapse without writing a cell subscript itself', () => {
    const source = stageEndHandlerSource(CURSED_ID);

    expect(source).not.toContain('cells[');
    expect(source).toContain('resizeBoard');
    expect(source).toContain('moveTile');
  });
});


describe('win and loss evaluation on the board a collapse left', () => {
  it('reports a loss once the collapse fills the tighter lattice', () => {
    // Nine tiles inside the region the collapse keeps, so the collapse re-homes
    // nothing and leaves every cell of the new lattice occupied.
    bench.grid = ladderGrid(DEFAULT_BOARD_SIZE, COLLAPSED_SIZE);
    expect(movesAvailable(bench.grid, bench.config)).toBe(true);
    expect(bench.grid.cellsAvailable()).toBe(true);

    pickUp(CURSED_ID);
    endStage(true);

    expect(bench.grid.size).toBe(COLLAPSED_SIZE);
    expect(occupants(bench.grid)).toHaveLength(COLLAPSED_SIZE ** 2);
    expect(bench.grid.cellsAvailable()).toBe(false);
    expect(tileMatchesAvailable(bench.grid, bench.config)).toBe(false);
    expect(movesAvailable(bench.grid, bench.config)).toBe(false);
  });

  it('reports a move still available where a collapse keeps an equal pair', () => {
    // A full default board carrying exactly one adjacent equal pair, at (0, 0)
    // and (1, 0), which both lie inside the region the collapse keeps.
    bench.grid = gridFromBoard(createNearLossBoard(DEFAULT_BOARD_SIZE));
    expect(movesAvailable(bench.grid, bench.config)).toBe(true);

    pickUp(CURSED_ID);
    endStage(true);

    expect(bench.grid.size).toBe(COLLAPSED_SIZE);
    expect(bench.grid.cellsAvailable()).toBe(false);
    expect(tileMatchesAvailable(bench.grid, bench.config)).toBe(true);
    expect(movesAvailable(bench.grid, bench.config)).toBe(true);
  });

  it('reads the win value from the rules, which a collapse never rewrites', () => {
    place(bench.grid, 0, 0, WIN_TILE_VALUE);
    place(bench.grid, 3, 3, 4);
    expect(hasReachedWinValue(bench.grid, bench.config)).toBe(true);

    pickUp(CURSED_ID);
    endStage(true);

    expect(bench.config.winValue).toBe(WIN_TILE_VALUE);
    expect(highestTileValue(bench.grid)).toBe(WIN_TILE_VALUE);
    expect(hasReachedWinValue(bench.grid, bench.config)).toBe(true);
  });

  it('drops the win value with the tile that carried it outside the bound', () => {
    // The only winning tile stands in the corner the collapse discards, and the
    // board is full, so nowhere inside the new bound stands empty for it.
    bench.grid = ladderGrid(DEFAULT_BOARD_SIZE, DEFAULT_BOARD_SIZE);
    expect(hasReachedWinValue(bench.grid, bench.config)).toBe(true);

    pickUp(CURSED_ID);
    endStage(true);

    expect(bench.grid.size).toBe(COLLAPSED_SIZE);
    expect(hasReachedWinValue(bench.grid, bench.config)).toBe(false);
    expect(highestTileValue(bench.grid)).toBe(32);
    expectCoherentLattice(bench.grid);
  });

  it('leaves both edge lengths untouched on every hook but the stage end', () => {
    place(bench.grid, 0, 0, 2);
    pickUp(CURSED_ID);

    const environment = {
      config: bench.config,
      rng: bench.streams,
      grid: bench.grid,
    };
    const board = bench.grid;

    for (const hook of HOOK_NAMES) {
      if (hook === 'onStageEnd') {
        continue;
      }

      switch (hook) {
        case 'onStageStart':
          bench.bus.dispatch(
            hook,
            {
              stageIndex: STAGE_INDEX,
              goal: stageGoalForIndex(STAGE_INDEX, createDefaultStageConfig()),
              seed: RUN_SEED,
              boardSize: bench.config.boardSize,
            },
            environment,
          );
          break;
        case 'onBeforeMove':
          bench.bus.dispatch(
            hook,
            { direction: 0, board, cancelled: false },
            environment,
          );
          break;
        case 'onMerge':
          resolveMerge();
          break;
        case 'onSpawn':
          bench.bus.dispatch(
            hook,
            { position: { x: 2, y: 2 }, value: 2 },
            environment,
          );
          break;
        case 'onAfterMove':
          bench.bus.dispatch(
            hook,
            {
              moved: true,
              board,
              score: STAGE_SCORE,
              over: false,
              won: false,
              terminated: false,
            },
            environment,
          );
          break;
      }
    }

    expect(bench.grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(bench.config.boardSize).toBe(DEFAULT_BOARD_SIZE);
    expect(occupants(bench.grid)).toEqual([{ x: 0, y: 0, value: 2 }]);
  });
});

/* ==========================================================================
 * 3. reconcileBoardSize: the pure resolution of the three candidate sizes
 *
 * Precedence is the relic-implied edge length, then the configured one, then
 * the recorded one.
 * ========================================================================== */

describe('reconcileBoardSize over a recorded snapshot', () => {
  /** The wide snapshot every case in this section resolves against. */
  function wideSnapshot(): SerializedGrid {
    return ladderGrid(WIDE_SIZE, DEFAULT_BOARD_SIZE).serialize();
  }

  /** Counts the tiles a reconciled snapshot holds. */
  function retained(reconciliation: SerializedGrid): number {
    return occupants(new Grid(reconciliation.size, reconciliation.cells))
      .length;
  }

  /** Reads the record without the grid beside it. */
  function record(
    savedGrid: SerializedGrid,
    configuredSize: number,
    relicBoardSize?: number,
  ): BoardSizeReconciliation {
    return reconcileBoardSize({ savedGrid, configuredSize, relicBoardSize })
      .reconciliation;
  }

  it('applies the recorded size where the configuration agrees with it', () => {
    const reconciliation = record(wideSnapshot(), WIDE_SIZE);

    expect(reconciliation.savedSize).toBe(WIDE_SIZE);
    expect(reconciliation.configuredSize).toBe(WIDE_SIZE);
    expect(reconciliation.relicSize).toBe(0);
    expect(reconciliation.appliedSize).toBe(WIDE_SIZE);
    expect(reconciliation.action).toBe('none');
    expect(reconciliation.tilesDropped).toBe(0);
    expect(reconciliation.reportable).toBe(false);
  });

  it('grows a narrower recorded board to the configured size with no relic', () => {
    const narrow = new Grid(COLLAPSED_SIZE);

    place(narrow, 0, 0, 2);

    const reconciliation = record(narrow.serialize(), DEFAULT_BOARD_SIZE);

    expect(reconciliation.savedSize).toBe(COLLAPSED_SIZE);
    expect(reconciliation.configuredSize).toBe(DEFAULT_BOARD_SIZE);
    expect(reconciliation.relicSize).toBe(0);
    expect(reconciliation.appliedSize).toBe(DEFAULT_BOARD_SIZE);
    expect(reconciliation.action).toBe('grew');
    expect(reconciliation.tilesDropped).toBe(0);
    expect(reconciliation.reportable).toBe(true);
  });

  it('keeps a collapsed board collapsed where a relic declares that size', () => {
    const narrow = new Grid(COLLAPSED_SIZE);

    place(narrow, 0, 0, 2);
    place(narrow, 2, 2, 8);

    const reconciliation = record(
      narrow.serialize(),
      DEFAULT_BOARD_SIZE,
      COLLAPSED_SIZE,
    );

    expect(reconciliation.savedSize).toBe(COLLAPSED_SIZE);
    expect(reconciliation.configuredSize).toBe(DEFAULT_BOARD_SIZE);
    expect(reconciliation.relicSize).toBe(COLLAPSED_SIZE);
    expect(reconciliation.appliedSize).toBe(COLLAPSED_SIZE);
    expect(reconciliation.action).toBe('none');
    expect(reconciliation.tilesDropped).toBe(0);
    expect(reconciliation.reportable).toBe(true);
  });

  it('shrinks a wider recorded board to the configured size', () => {
    const reconciliation = record(wideSnapshot(), DEFAULT_BOARD_SIZE);

    expect(reconciliation.savedSize).toBe(WIDE_SIZE);
    expect(reconciliation.configuredSize).toBe(DEFAULT_BOARD_SIZE);
    expect(reconciliation.appliedSize).toBe(DEFAULT_BOARD_SIZE);
    expect(reconciliation.action).toBe('shrank');

    // Every tile of the recorded board stood inside the applied bound.
    expect(reconciliation.tilesDropped).toBe(0);
    expect(reconciliation.reportable).toBe(true);
  });

  it('counts exactly the tiles the applied bound left behind', () => {
    const savedGrid = wideSnapshot();
    const recorded = retained(savedGrid);
    const resolved = reconcileBoardSize({
      savedGrid,
      configuredSize: DEFAULT_BOARD_SIZE,
      relicBoardSize: COLLAPSED_SIZE,
    });

    expect(recorded).toBe(DEFAULT_BOARD_SIZE ** 2);
    expect(resolved.grid.size).toBe(COLLAPSED_SIZE);
    expect(retained(resolved.grid)).toBe(COLLAPSED_SIZE ** 2);
    expect(resolved.reconciliation.tilesDropped).toBe(
      recorded - retained(resolved.grid),
    );
    expect(resolved.reconciliation.tilesDropped).toBe(7);
  });

  it('rebuilds a coherent lattice at the applied size in every ordering', () => {
    const savedGrid = wideSnapshot();
    const orderings: readonly (readonly [number, number | undefined])[] = [
      [WIDE_SIZE, undefined],
      [DEFAULT_BOARD_SIZE, undefined],
      [DEFAULT_BOARD_SIZE, COLLAPSED_SIZE],
      [COLLAPSED_SIZE, undefined],
    ];

    for (const [configuredSize, relicBoardSize] of orderings) {
      const resolved = reconcileBoardSize({
        savedGrid,
        configuredSize,
        relicBoardSize,
      });
      const applied = resolved.reconciliation.appliedSize;
      const rebuilt = new Grid(applied, resolved.grid.cells);

      expect(resolved.grid.size).toBe(applied);
      expect(resolved.grid.cells).toHaveLength(applied);
      expectCoherentLattice(rebuilt);
    }
  });

  it('resolves every ordering without raising', () => {
    const savedGrid = wideSnapshot();

    expect(() => record(savedGrid, WIDE_SIZE)).not.toThrow();
    expect(() => record(savedGrid, DEFAULT_BOARD_SIZE)).not.toThrow();
    expect(() =>
      record(savedGrid, DEFAULT_BOARD_SIZE, COLLAPSED_SIZE),
    ).not.toThrow();
    expect(() => record(savedGrid, COLLAPSED_SIZE)).not.toThrow();
  });
});


/* ==========================================================================
 * 4. The reload half: persist through the real store, load, reconcile
 *
 * The vanilla loader rebuilt the grid from the size the snapshot recorded, at
 * js/game_manager.js L40-L41, and nothing weighed that size against the
 * configuration.
 * ========================================================================== */

describe('a collapsed run persisted and loaded again', () => {
  /**
   * Collapses the bench's board and persists the result.
   *
   * @returns The snapshot that was written and the envelope carrying it.
   */
  function collapseAndSave(): {
    readonly snapshot: SerializedGrid;
    readonly envelope: RunState;
  } {
    place(bench.grid, 0, 0, 2);
    place(bench.grid, 1, 1, 8);
    place(bench.grid, 3, 3, 4);
    pickUp(CURSED_ID);
    endStage(true);

    const snapshot = bench.grid.serialize();
    const envelope = envelopeFor(
      snapshot,
      bench.registry.serialize(),
      bench.streams.snapshotCursors(),
    );

    expect(envelope.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(bench.store.save(envelope)).toBe(true);
    expect(bench.writeFailures).toEqual([]);
    expect(rawValue(bench.backing, RUN_STATE_KEY)).not.toBeNull();

    return { snapshot, envelope };
  }

  it('round-trips the collapsed snapshot through storage unchanged', () => {
    const { snapshot } = collapseAndSave();
    const loaded = bench.store.load();

    expect(loaded.state).not.toBeNull();
    expect(loaded.state?.board.grid.size).toBe(COLLAPSED_SIZE);
    expect(loaded.state?.board.grid).toEqual(snapshot);
    expect(loaded.reconciliation?.appliedSize).toBe(COLLAPSED_SIZE);
    expect(loaded.reconciliation?.action).toBe('none');
    expect(loaded.reconciliation?.tilesDropped).toBe(0);

    // Every empty cell came back as `null`, never omitted or compacted.
    for (const column of loaded.state?.board.grid.cells ?? []) {
      expect(column).toHaveLength(COLLAPSED_SIZE);

      for (const cell of column) {
        expect(cell === null || typeof cell === 'object').toBe(true);
      }
    }
  });

  it('rebuilds the loaded snapshot into a lattice holding the same tiles', () => {
    const before = collapseAndSave();
    const recorded = occupants(bench.grid);
    const loaded = bench.store.load();
    const applied = loaded.reconciliation?.appliedSize ?? 0;
    const rebuilt = new Grid(applied, loaded.state?.board.grid.cells ?? null);

    expect(applied).toBe(before.snapshot.size);
    expect(rebuilt.size).toBe(COLLAPSED_SIZE);
    expect(occupants(rebuilt)).toEqual(recorded);
    expectCoherentLattice(rebuilt);
  });

  it('reads win and loss at the reconciled size, not the recorded or configured one', () => {
    // A run whose relic collapsed the board to three while the envelope still
    // carried the wider board, loaded against a configuration declaring four.
    // The three candidate sizes give three DIFFERENT verdict pairs.
    place(bench.grid, 0, 0, 2);
    place(bench.grid, 3, 3, 4);
    pickUp(CURSED_ID);
    endStage(true);

    const persistedRelics = bench.registry.serialize();

    expect(persistedRelics).toEqual([
      { id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } },
    ]);

    const wide = ladderGrid(WIDE_SIZE, DEFAULT_BOARD_SIZE);
    const wideSnapshot = wide.serialize();
    const store = storeConfiguredAt(DEFAULT_BOARD_SIZE);

    expect(
      store.save(
        envelopeFor(
          wideSnapshot,
          persistedRelics,
          bench.streams.snapshotCursors(),
        ),
      ),
    ).toBe(true);

    const loaded = store.load();
    const reconciliation = loaded.reconciliation;

    expect(reconciliation?.savedSize).toBe(WIDE_SIZE);
    expect(reconciliation?.configuredSize).toBe(DEFAULT_BOARD_SIZE);
    expect(reconciliation?.relicSize).toBe(COLLAPSED_SIZE);
    expect(reconciliation?.appliedSize).toBe(COLLAPSED_SIZE);
    expect(reconciliation?.tilesDropped).toBe(7);

    const verdicts = createDefaultRulesConfig();
    const applied = new Grid(
      reconciliation?.appliedSize ?? 0,
      loaded.state?.board.grid.cells ?? null,
    );
    const atRecorded = gridFromBoard(
      copyBoard({ ...createEmptyBoard(WIDE_SIZE), grid: wideSnapshot }),
    );
    const atConfigured = new Grid(
      DEFAULT_BOARD_SIZE,
      throughText(wideSnapshot).cells,
    );

    // The verdict the reconciled lattice reports.
    expect(applied.size).toBe(COLLAPSED_SIZE);
    expect(movesAvailable(applied, verdicts)).toBe(false);
    expect(hasReachedWinValue(applied, verdicts)).toBe(false);
    expect(highestTileValue(applied)).toBe(32);

    // The verdict a check stuck on the recorded size would have reported.
    expect(atRecorded.size).toBe(WIDE_SIZE);
    expect(movesAvailable(atRecorded, verdicts)).toBe(true);
    expect(hasReachedWinValue(atRecorded, verdicts)).toBe(true);

    // The verdict a check stuck on the configured size would have reported.
    expect(atConfigured.size).toBe(DEFAULT_BOARD_SIZE);
    expect(movesAvailable(atConfigured, verdicts)).toBe(false);
    expect(hasReachedWinValue(atConfigured, verdicts)).toBe(true);

    // All three pairs differ, so the assertion above discriminates.
    expect(highestTileValue(atRecorded)).toBe(WIN_TILE_VALUE);
    expect(highestTileValue(atConfigured)).toBe(WIN_TILE_VALUE);
  });

  it('classifies the load as reconciled and reports it with the run identifier', () => {
    collapseAndSave();

    const loaded = bench.store.load();

    expect(loaded.verdict).toBe('current');
    expect(loaded.outcome).toBe('reconciled');
    expect(loaded.reconciliation?.reportable).toBe(true);
    expect(bench.reconciled).toEqual([
      {
        correlationId: CORRELATION_ID,
        savedSize: COLLAPSED_SIZE,
        configuredSize: COLLAPSED_SIZE,
        relicSize: COLLAPSED_SIZE,
        appliedSize: COLLAPSED_SIZE,
      },
    ]);
  });

  it('classifies a load resolving no size decision as a plain load', () => {
    pickUp(BANKING_ID);
    resolveMerge();
    place(bench.grid, 0, 0, 2);

    const envelope = envelopeFor(
      bench.grid.serialize(),
      bench.registry.serialize(),
      bench.streams.snapshotCursors(),
    );

    expect(bench.store.save(envelope)).toBe(true);

    const loaded = bench.store.load();

    expect(loaded.state?.board.grid.size).toBe(DEFAULT_BOARD_SIZE);
    expect(loaded.reconciliation?.relicSize).toBe(0);
    expect(loaded.reconciliation?.reportable).toBe(false);
    expect(loaded.outcome).toBe('loaded');
    expect(bench.reconciled).toEqual([]);
  });

  it('falls back to a fresh run for a truncated stored value without raising', () => {
    bench.backing.setItem(RUN_STATE_KEY, '{"schemaVersion":1,"runId":"boa');

    const loaded = bench.store.load();

    expect(loaded.state).toBeNull();
    expect(loaded.outcome).toBe('fresh-fallback');

    // The diagnosis reaches the caller rather than being discarded. Its exact
    // wording per malformation belongs to tests/unit/run/run-state-store.test.ts.
    expect(Array.isArray(loaded.problems)).toBe(true);
    expect(loaded.problems ?? []).not.toHaveLength(0);

    for (const problem of loaded.problems ?? []) {
      expect(typeof problem).toBe('string');
      expect(problem).not.toBe('');
    }

    expect(bench.corrupted).toHaveLength(1);
    expect(bench.corrupted[0].correlationId).toBe(CORRELATION_ID);
    expect(bench.corrupted[0].key).toBe(RUN_STATE_KEY);
    expect(bench.storageFailures).toContain(`read:${RUN_STATE_KEY}`);
    expect(() => bench.store.load()).not.toThrow();
  });

  it('leaves the frozen best-score and board-snapshot keys exactly as they were', () => {
    const seededGameState = JSON.stringify({
      grid: { size: DEFAULT_BOARD_SIZE, cells: [] },
      score: 8,
      over: false,
      won: false,
      keepPlaying: false,
    });

    bench.backing.setItem(BEST_SCORE_KEY, SEEDED_BEST_SCORE);
    bench.backing.setItem(GAME_STATE_KEY, seededGameState);
    collapseAndSave();
    bench.store.load();
    bench.store.clear();

    // The accessor yields the raw stored text when a value is present, which is
    // what the promotion comparison of js/game_manager.js L80-L82 relies on.
    expect(bench.manager.getBestScore()).toBe(SEEDED_BEST_SCORE);
    expect(typeof bench.manager.getBestScore()).toBe('string');
    expect(rawValue(bench.backing, BEST_SCORE_KEY)).toBe(SEEDED_BEST_SCORE);
    expect(rawValue(bench.backing, GAME_STATE_KEY)).toBe(seededGameState);
    expect(rawValue(bench.backing, RUN_STATE_KEY)).toBeNull();
  });

  it('carries the draw counts across, so a resumed run continues the sequence', () => {
    collapseAndSave();

    const recorded = bench.streams.snapshotCursors();
    const loaded = bench.store.load();

    expect(loaded.state?.rngCursor).toEqual(recorded);
    expect(loaded.state?.seed).toBe(RUN_SEED);
    expect(loaded.state?.runId).toBe(RUN_ID);

    // One tile stood outside the new bound and one re-homing draw was taken.
    expect(recorded).toEqual({
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 1,
      'rarity-weight': 0,
    });

    const resumed = createRngStreams(
      loaded.state?.seed ?? '',
      loaded.state?.rngCursor,
    );

    expect(resumed.snapshotCursors()).toEqual(recorded);

    for (const name of ['relic-draw', 'spawn-value'] as const) {
      expect(resumed.stream(name).next()).toBe(
        bench.streams.stream(name).next(),
      );
    }
  });
});


/* ==========================================================================
 * 5. A collapse beside a relic that persists a slot of its own
 * ========================================================================== */

describe('a collapsed run holding a second relic with its own slot', () => {
  /**
   * Takes both relics on, banks a few merges, then clears the stage.
   *
   * @returns The entries the registry projects for the envelope.
   */
  function collectAndCollapse(): readonly PersistedRelic[] {
    place(bench.grid, 0, 0, 2);
    place(bench.grid, 3, 3, 4);
    pickUp(CURSED_ID);
    pickUp(BANKING_ID);

    for (let merge = 0; merge < BANKED_MERGES; merge += 1) {
      resolveMerge();
    }

    endStage(true);

    return bench.registry.serialize();
  }

  /**
   * Restores entries into a registry over a bus of its own.
   *
   * @param persisted Entries to restore, in pickup order.
   * @returns The registry and the bus its handlers were registered with.
   */
  function restoreInto(persisted: readonly PersistedRelic[]): {
    readonly registry: RelicRegistry;
    readonly bus: HookBus;
  } {
    const bus = createHookBus({
      correlationId: CORRELATION_ID,
      reporter: NOOP_ENGINE_REPORTER,
    });
    const registry = new RelicRegistry({
      bus,
      reporter: NOOP_ENGINE_REPORTER,
      correlationId: CORRELATION_ID,
    });

    registry.restore(persisted);

    return { registry, bus };
  }

  it('carries both slots and pickup order across a save and a load', () => {
    const persisted = collectAndCollapse();

    expect(persisted).toEqual([
      { id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } },
      { id: BANKING_ID, state: BANKED_MERGES },
    ]);

    const before = projectHeld(bench.registry.active());

    expect(bench.store.save(
      envelopeFor(
        bench.grid.serialize(),
        persisted,
        bench.streams.snapshotCursors(),
      ),
    )).toBe(true);

    const loaded = requireState(bench.store.load());

    expect(loaded.relics).toEqual(persisted);

    const restored = restoreInto(loaded.relics);

    expect(projectHeld(restored.registry.active())).toEqual(before);
    expect(restored.registry.ownedIds()).toEqual([CURSED_ID, BANKING_ID]);
    expect(
      restored.bus
        .subscriptions('onStageEnd')
        .map((subscription) => subscription.subscriberId),
    ).toEqual([CURSED_ID, BANKING_ID]);
  });

  it('leaves the restored relics acting correctly at the reconciled size', () => {
    const persisted = collectAndCollapse();

    expect(bench.store.save(
      envelopeFor(
        bench.grid.serialize(),
        persisted,
        bench.streams.snapshotCursors(),
      ),
    )).toBe(true);

    const loaded = requireState(bench.store.load());
    const restored = restoreInto(loaded.relics);
    const config = createDefaultRulesConfig();

    config.boardSize = loaded.board.grid.size;

    const grid = new Grid(config.boardSize, loaded.board.grid.cells);
    const streams = createRngStreams(loaded.seed, loaded.rngCursor);
    const environment = { config, rng: streams, grid };

    // The banked slot came back live: the bonus it pays is the bank it holds.
    expect(
      restored.bus.dispatch(
        'onMerge',
        {
          source: new Tile({ x: 1, y: 0 }, 2),
          target: new Tile({ x: 0, y: 0 }, 2),
          resultValue: MERGE_RESULT_VALUE,
          scoreDelta: MERGE_SCORE_DELTA,
        },
        environment,
      ).payload.scoreDelta,
    ).toBe(MERGE_SCORE_DELTA + BANKED_MERGES * BANK_BONUS_PER_CHARGE);

    // A second collapse against a board already standing at the floor records
    // no command at all, so no cell outside the lattice is addressed.
    const again = restored.bus.dispatch(
      'onStageEnd',
      { stageIndex: STAGE_INDEX + 1, cleared: true, score: STAGE_SCORE },
      environment,
    );

    expect(again.effectsApplied).toBe(0);
    expect(again.failed).toBe(0);
    expect(restored.bus.degraded()).toEqual([]);
    expect(grid.size).toBe(COLLAPSED_SIZE);
    expect(config.boardSize).toBe(COLLAPSED_SIZE);
    expectCoherentLattice(grid);
  });

  it('persists every slot as plain JSON data', () => {
    const persisted = collectAndCollapse();

    expect(persisted).toHaveLength(2);

    for (const entry of persisted) {
      // A slot holding a Map, a function or an undefined member would not
      // survive the envelope's own serialisation.
      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
      expect(Object.keys(entry).sort()).toEqual(['id', 'state']);
      expect('charges' in entry).toBe(false);
    }

    // One slot is a keyed record carrying no inherited member, the other a bare
    // number: both are values JSON text represents directly.
    expect(typeof persisted[0].state).toBe('object');
    expect(Object.getPrototypeOf(persisted[0].state)).toBeNull();
    expect(typeof persisted[1].state).toBe('number');
    expect(Number.isSafeInteger(persisted[1].state)).toBe(true);
  });
});

/* ==========================================================================
 * 6. Determinism and substream hygiene
 * ========================================================================== */

describe('the collapse, persist and reload sequence under one seed', () => {
  it('produces the same board and the same draw counts on every run', () => {
    const first = runSequence(RUN_SEED);
    const second = runSequence(RUN_SEED);

    expect(second.board).toEqual(first.board);
    expect(second.cursors).toEqual(first.cursors);
    expect(second.relics).toEqual(first.relics);
    expect(second.applied).toBe(first.applied);
    expect(second.outcome).toBe(first.outcome);
    expect(first.applied).toBe(COLLAPSED_SIZE);
  });

  it('takes no draw at all where the collapse re-homes nothing', () => {
    bench.grid = ladderGrid(DEFAULT_BOARD_SIZE, COLLAPSED_SIZE);
    pickUp(CURSED_ID);
    endStage(true);

    expect(bench.grid.size).toBe(COLLAPSED_SIZE);
    expect(cursorOf('relic-draw')).toBe(0);
    expect(cursorOf('rarity-weight')).toBe(0);
    expect(cursorOf('spawn-value')).toBe(0);
    expect(cursorOf('spawn-position')).toBe(0);
  });

  it('takes one relic-draw per re-homing and never touches rarity-weight', () => {
    place(bench.grid, 0, 0, 2);
    place(bench.grid, 3, 0, 16);
    place(bench.grid, 0, 3, 32);
    place(bench.grid, 3, 3, 4);
    pickUp(CURSED_ID);
    endStage(true);

    // Three tiles stood outside the new bound and all three were re-homed.
    expect(occupants(bench.grid)).toHaveLength(4);
    expect(cursorOf('relic-draw')).toBe(3);

    // The substream the reward draw reads is untouched, so the offer set the
    // next screen draws is the offer set this seed already produced.
    expect(cursorOf('rarity-weight')).toBe(0);
    expect(cursorOf('spawn-value')).toBe(0);
    expect(cursorOf('spawn-position')).toBe(0);
  });

  it('leaves the stage-end payload as it arrived', () => {
    place(bench.grid, 0, 0, 2);
    pickUp(CURSED_ID);

    expect(endStage(true)).toEqual({
      stageIndex: STAGE_INDEX,
      cleared: true,
      score: STAGE_SCORE,
    });
  });

  it('reads no global random source in the handler that collapses the board', () => {
    expect(stageEndHandlerSource(CURSED_ID)).not.toContain('Math.random');
    expect(stageEndHandlerSource(BANKING_ID)).not.toContain('Math.random');
    expect(relicFromFamily(CURSED_ID).id).toBe(CURSED_ID);
    expect(relicFromFamily(CURSED_ID).charges).toBeUndefined();
  });
});

/* ==========================================================================
 * 7. Frame hygiene
 * ========================================================================== */

describe('the rules configuration a collapse wrote', () => {
  it('is rebuilt per test, so no collapsed edge length leaks out of one', () => {
    place(bench.grid, 0, 0, 2);
    pickUp(CURSED_ID);
    endStage(true);

    expect(bench.config.boardSize).toBe(COLLAPSED_SIZE);

    // A configuration built after the write still declares the default, so the
    // reconciliation one relic performed reaches no later run and no later test.
    expect(createDefaultRulesConfig().boardSize).toBe(DEFAULT_BOARD_SIZE);
    expect(createDefaultRulesConfig().winValue).toBe(WIN_TILE_VALUE);
    expect(new Grid(createDefaultRulesConfig().boardSize).size).toBe(
      DEFAULT_BOARD_SIZE,
    );
  });

  it('starts every test with an empty store and no relic held', () => {
    for (const key of OWNED_STORAGE_KEYS) {
      expect(rawValue(bench.backing, key)).toBeNull();
    }

    expect(bench.store.exists()).toBe(false);
    expect(bench.registry.size()).toBe(0);
    expect(bench.reconciled).toEqual([]);
    expect(bench.corrupted).toEqual([]);
    expect(bench.storageFailures).toEqual([]);
    expect(bench.streams.snapshotCursors()).toEqual({
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    });
  });
});
