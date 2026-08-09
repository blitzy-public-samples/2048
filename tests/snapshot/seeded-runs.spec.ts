// Seeded run snapshots: the separately stored regression gate of AAP V1 and V2.
//
// PINNED VANILLA CONSTRUCTS, and the expectation each one supplies:
//   js/application.js            L3        board size 4
//   js/game_manager.js           L7        two start tiles
//   js/game_manager.js           L36       setup() reads the snapshot once
//   js/game_manager.js           L62-L76   addStartTiles, then addRandomTile
//                                          taking the value draw before the
//                                          position draw
//   js/game_manager.js           L102-L110 serialize(), keepPlaying included
//   js/game_manager.js           L134      the terminal-state guard
//   js/game_manager.js           L156      canMerge: equal value, and the
//                                          target not already merged
//   js/game_manager.js           L157      produce: twice the value
//   js/game_manager.js           L167      score += merged.value
//   js/game_manager.js           L170      win value 2048
//   js/grid.js                   L37-L43   randomAvailableCell, and its
//                                          full-board guard with no else
//   js/grid.js                   L45-L64   availableCells and eachCell,
//                                          x-outer and y-inner
//   js/grid.js                   L80-L86   cellContent, null off the lattice
//   js/local_storage_manager.js  L22       the frozen best-score key
//   js/local_storage_manager.js  L25-L26   the writability probe, once at
//                                          construction
//   js/local_storage_manager.js  L43-L45   getBestScore(): the stored string
//                                          when a value is set
//
// The seeded substreams replace exactly two platform-randomness call sites, and
// the repository held no others: js/game_manager.js L71, the spawn value, and
// js/grid.js L41, the spawn position. Section 8 measures that the platform
// generator itself is left unpatched, against the reference
// tests/fixtures/math-random-reference.ts captured.
//
// The `snapshot` project runs in the `node` environment: no document and no Web
// Storage. Every store below is a MemoryStorage behind the real manager.
//
// Snapshot artifacts land in tests/snapshot/__snapshots__/ through
// `resolveSnapshotPath` of vitest.snapshot.config.ts.
//
// Decisions behind this file are recorded in docs/DECISION_LOG.md.

// DECLARED FIRST. A module's dependencies are evaluated in the order their
// declarations appear, and this one captures the platform generator in its own
// body; it imports nothing.
import {
  PLATFORM_MATH_RANDOM,
  PLATFORM_MATH_RANDOM_DESCRIPTOR,
} from '../fixtures/math-random-reference';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../src/config/default-config';
import type { MergeTileView } from '../../src/config/rules-config';
import {
  createDefaultStageConfig,
  stageGoalForIndex,
} from '../../src/config/stage-config';
import { Engine } from '../../src/engine/engine';
import { ENGINE_EVENT_NAMES } from '../../src/engine/engine-events';
import { Grid } from '../../src/engine/grid';
import { createHookBus } from '../../src/engine/hook-bus';
import type { HookBus } from '../../src/engine/hook-bus';
import { movesAvailable } from '../../src/engine/terminal-state';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  type Direction,
  type SerializedGameState,
  type SerializedTile,
} from '../../src/engine/types';
import { drawRelicOffers } from '../../src/relics/relic-draw';
import { RELIC_CATALOGUE } from '../../src/relics/relic-registry';
import type { Relic } from '../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
  type RngCursorMap,
  type RngStreams,
} from '../../src/rng/rng-streams';
import { createSeededRng } from '../../src/rng/seeded-rng';
import {
  RUN_STATE_SCHEMA_VERSION,
  createFreshRunState,
  type RunState,
} from '../../src/run/run-state';
import { RunStateStore } from '../../src/run/run-state-store';
import { LocalStorageManager } from '../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  OWNED_STORAGE_KEYS,
} from '../../src/storage/storage-keys';
import {
  BLOCKED_BOARD,
  EMPTY_BOARD,
  MERGE_PAIR_BOARD,
  NEAR_LOSS_BOARD,
  NEAR_WIN_BOARD,
  copyBoard,
} from '../fixtures/boards';

/* ==========================================================================
 * 1. Harness
 * ========================================================================== */

/** The run seed every leg below plays from. */
const RUN_SEED = 'run-seed-2048';

/** A second seed. Its board is compared against `RUN_SEED`'s. */
const OTHER_RUN_SEED = 'run-seed-2049';

/** Run identifier the persisted envelope carries, fixed rather than drawn. */
const FIXED_RUN_ID = 'seeded-runs-fixture';

/**
 * Directions every leg plays, in this order. Eight moves cycling all four
 * directions twice, which under `RUN_SEED` resolves eight turns, spawns eight
 * tiles and merges.
 */
const MOVE_LIST: readonly Direction[] = [
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
];

/** `MOVE_LIST` three times over, played to reach a terminal board. */
const TERMINAL_MOVE_LIST: readonly Direction[] = [
  ...MOVE_LIST,
  ...MOVE_LIST,
  ...MOVE_LIST,
];

/** Moves played before the run is interrupted and persisted. */
const MOVES_BEFORE_RELOAD = 4;

/** Offer sets drawn in sequence, one per stage. */
const OFFER_SET_COUNT = 3;

/** Relics offered per set. */
const OFFERS_PER_SET = 3;

/** Offers drawn between moves by the interleaving leg. */
const INTERLEAVED_OFFER_COUNT = 2;

/** Board edge length js/application.js L3 declared. */
const VANILLA_BOARD_SIZE = 4;

/** Width of one rendered cell. Fits every value the tile ramp defines. */
const CELL_WIDTH = 6;

/** What an empty cell renders as. */
const EMPTY_CELL = '.';

/** Width the substream names are padded to. */
const STREAM_NAME_WIDTH = 16;

/**
 * A pool declared here rather than read from `RELIC_CATALOGUE`. One relic per
 * tier of `RARITIES`, and no bound handler: nothing below registers these on a
 * bus.
 */
const HAND_BUILT_POOL: readonly Relic[] = [
  {
    id: 'gate-common',
    name: 'Gate Common',
    rarity: 'common',
    description: 'A pool member of the common tier.',
    hooks: {},
  },
  {
    id: 'gate-uncommon',
    name: 'Gate Uncommon',
    rarity: 'uncommon',
    description: 'A pool member of the uncommon tier.',
    hooks: {},
  },
  {
    id: 'gate-rare',
    name: 'Gate Rare',
    rarity: 'rare',
    description: 'A pool member of the rare tier.',
    hooks: {},
  },
  {
    id: 'gate-legendary',
    name: 'Gate Legendary',
    rarity: 'legendary',
    description: 'A pool member of the legendary tier.',
    hooks: {},
  },
];

/** Injected stores this file created, emptied after every test. */
const injectedStores: MemoryStorage[] = [];

/** Builds a store and registers it for teardown. */
function createBacking(): MemoryStorage {
  const backing = new MemoryStorage();

  injectedStores.push(backing);

  return backing;
}

/**
 * Removes every key `src/storage/storage-keys.ts` reports as owned from every
 * store this file built, and empties the registry.
 *
 * `BEST_SCORE_KEY` is removed by name as well as through the list: no member of
 * the vanilla manager removed it, and promotion only ever raised it.
 */
function clearInjectedStores(): void {
  for (const backing of injectedStores) {
    for (const key of OWNED_STORAGE_KEYS) {
      backing.removeItem(key);
    }

    backing.removeItem(BEST_SCORE_KEY);
  }

  injectedStores.length = 0;
}

/** Removes the owned keys from ambient Web Storage where one exists. */
function clearAmbientOwnedKeys(): void {
  if (typeof localStorage === 'undefined') {
    return;
  }

  for (const key of OWNED_STORAGE_KEYS) {
    localStorage.removeItem(key);
  }

  localStorage.removeItem(BEST_SCORE_KEY);
}

afterEach(() => {
  clearInjectedStores();
  clearAmbientOwnedKeys();
});

/**
 * Renders one board snapshot as fixed-width columns under a metadata line.
 *
 * The walk is x-outer and y-inner, the traversal js/grid.js L58-L64 fixed and
 * the order `availableCells()` inherits from it, so each line is one column of
 * the persisted `cells[x][y]` matrix.
 */
function projectBoard(state: SerializedGameState): string {
  const size = state.grid.size;
  const lines: string[] = [
    `size ${String(size)}  score ${String(state.score)}  ` +
      `over ${String(state.over)}  won ${String(state.won)}  ` +
      `keepPlaying ${String(state.keepPlaying)}`,
  ];

  for (let x = 0; x < size; x += 1) {
    const rendered: string[] = [];

    for (let y = 0; y < size; y += 1) {
      const cell: SerializedTile | null = state.grid.cells[x]?.[y] ?? null;

      rendered.push(
        (cell === null ? EMPTY_CELL : String(cell.value)).padStart(CELL_WIDTH),
      );
    }

    lines.push(`x=${String(x)}${rendered.join('')}`);
  }

  return lines.join('\n');
}

/**
 * Renders a cursor map in `RNG_STREAM_NAMES` order rather than in the object's
 * own key order.
 */
function projectCursors(cursors: RngCursorMap): string {
  return RNG_STREAM_NAMES.map(
    (name) => `  ${name.padEnd(STREAM_NAME_WIDTH)}${String(cursors[name])}`,
  ).join('\n');
}

/** Renders the nine members of one run-state envelope, in declared order. */
function projectEnvelope(state: RunState): string {
  return [
    `schemaVersion  ${String(state.schemaVersion)}`,
    `runId          ${state.runId}`,
    `seed           ${state.seed}`,
    `stageIndex     ${String(state.stageIndex)}`,
    `stageGoal      ${state.stageGoal.kind} ` +
      `${String(state.stageGoal.target)}`,
    `goalProgress   ${String(state.goalProgress)}`,
    `relics         ${String(state.relics.length)} held`,
    'rngCursor',
    projectCursors(state.rngCursor),
    'board',
    projectBoard(state.board),
  ].join('\n');
}

/**
 * One tile as the merge predicate reads it: its value, and whether it already
 * merged this turn. js/game_manager.js L158 assigned `mergedFrom` the pair of
 * tiles a merge consumed.
 */
function mergeView(value: number, alreadyMerged: boolean): MergeTileView {
  return { value, mergedFrom: alreadyMerged ? [value, value] : null };
}

/** What one leg of a seeded run is driven with. */
interface RunLegOptions {
  readonly seed: string;

  /** Directions to play. `MOVE_LIST` when absent. */
  readonly moves?: readonly Direction[];

  /** Board to restore. A fresh board is seeded when absent. */
  readonly board?: SerializedGameState;

  /** Bus the engine dispatches its hooks through. A private one when absent. */
  readonly hooks?: HookBus;

  /** Runs after construction and before `setup()`. */
  readonly attach?: (engine: Engine) => void;

  /** Runs before each move. */
  readonly betweenMoves?: (streams: RngStreams) => void;
}

/** What one leg of a seeded run produced. */
interface RunLeg {
  readonly engine: Engine;
  readonly streams: RngStreams;

  /** The board as js/game_manager.js L102-L110 projected it. */
  readonly serialized: SerializedGameState;
  readonly cursors: RngCursorMap;

  /** Whether each move in order changed the board. */
  readonly resolved: readonly boolean[];
}

/**
 * Drives one seeded run and reports what it produced.
 *
 * No reporter, logger, tracer, metrics collector, relic registry, run
 * controller or renderer is wired: every one of those is a subscriber, and the
 * `NOOP_*` defaults of src/engine/ apply where none is passed.
 */
function driveRun(options: RunLegOptions): RunLeg {
  const config = createDefaultRulesConfig();
  const streams = createRngStreams(options.seed);
  const engine = new Engine({
    config,
    streams,
    hooks: options.hooks,
    storage: new LocalStorageManager({ storage: createBacking() }),
  });

  options.attach?.(engine);

  // js/game_manager.js L13 called setup() from the constructor; here the
  // caller does, after a subscriber has attached.
  engine.setup(options.board);

  const resolved: boolean[] = [];

  for (const direction of options.moves ?? MOVE_LIST) {
    options.betweenMoves?.(streams);
    resolved.push(engine.move(direction));
  }

  return {
    engine,
    streams,
    serialized: engine.serialize(),
    cursors: streams.snapshotCursors(),
    resolved,
  };
}

/** Renders one leg: its board, the cursors it reached, and its turn count. */
function renderLeg(leg: RunLeg): string {
  const turns = leg.resolved.filter((moved) => moved).length;

  return [
    projectBoard(leg.serialized),
    'rngCursor',
    projectCursors(leg.cursors),
    `turns resolved  ${String(turns)} of ${String(leg.resolved.length)}`,
  ].join('\n');
}

/**
 * Draws `OFFER_SET_COUNT` sets of `OFFERS_PER_SET` offers from `pool`, taking
 * the first offer of each set into the owned list before the next set is drawn.
 *
 * @returns The identifiers of each set, in draw order.
 */
function drawOfferSets(
  streams: RngStreams,
  pool: readonly Relic[],
): readonly (readonly string[])[] {
  const owned: string[] = [];
  const sets: string[][] = [];

  for (let stage = 0; stage < OFFER_SET_COUNT; stage += 1) {
    const offers = drawRelicOffers({
      pool,
      ownedIds: owned,
      count: OFFERS_PER_SET,
      streams,
    });
    const ids = offers.map((relic) => relic.id);

    sets.push(ids);

    const taken = ids[0];

    if (taken !== undefined) {
      owned.push(taken);
    }
  }

  return sets;
}

/** Renders offer sets, one line per set, numbered from 1. */
function projectOfferSets(sets: readonly (readonly string[])[]): string {
  return sets
    .map((ids, index) => `  set ${String(index + 1)}  ${ids.join(', ')}`)
    .join('\n');
}

/** Renders a dispatch record one line per dispatch, numbered from 1. */
function projectDispatchPairs(record: readonly string[]): string {
  const lines: string[] = [];

  for (let index = 0; index < record.length; index += 2) {
    const ordinal = String(index / 2 + 1).padStart(2);

    lines.push(`  ${ordinal}. ${record.slice(index, index + 2).join(' ')}`);
  }

  return lines.join('\n');
}

/* ==========================================================================
 * 2. The frozen rule literals
 * ========================================================================== */

describe('js/application.js L3 — the sole board-size literal', () => {
  it('configures a board four cells to an edge', () => {
    expect(createDefaultRulesConfig().boardSize).toBe(VANILLA_BOARD_SIZE);
  });
});

describe('js/game_manager.js L170 — the mighty 2048 tile', () => {
  it('configures a win value of 2048', () => {
    expect(createDefaultRulesConfig().winValue).toBe(2048);
  });
});

describe('js/game_manager.js L7 — this.startTiles', () => {
  it('configures two start tiles', () => {
    expect(createDefaultRulesConfig().startTiles).toBe(2);
  });
});

describe('js/game_manager.js L71 — the spawn distribution', () => {
  it('configures the values [2, 4] at the weights [0.9, 0.1]', () => {
    const spawn = createDefaultRulesConfig().spawn;

    expect(spawn.values).toEqual([2, 4]);
    expect(spawn.weights).toEqual([0.9, 0.1]);
  });
});

describe('js/game_manager.js L156 — the merge predicate', () => {
  it('accepts equal values where the target has not merged', () => {
    const canMerge = createDefaultRulesConfig().merge.canMerge;

    expect(canMerge(mergeView(4, false), mergeView(4, false))).toBe(true);
  });

  it('refuses a target that already merged this turn', () => {
    const canMerge = createDefaultRulesConfig().merge.canMerge;

    expect(canMerge(mergeView(4, false), mergeView(4, true))).toBe(false);
  });

  it('refuses unequal values', () => {
    const canMerge = createDefaultRulesConfig().merge.canMerge;

    expect(canMerge(mergeView(2, false), mergeView(4, false))).toBe(false);
  });
});

describe('js/game_manager.js L157 — the merge producer', () => {
  it('produces twice the merged value', () => {
    const produce = createDefaultRulesConfig().merge.produce;

    expect(produce(mergeView(2, false), mergeView(2, false))).toBe(4);
    expect(produce(mergeView(1024, false), mergeView(1024, false))).toBe(2048);
  });
});

describe('js/game_manager.js L167 — self.score += merged.value', () => {
  it('adds the merged value and not the value of the moving tile', () => {
    // MERGE_PAIR_BOARD holds two tiles of value 2, so one move merges them.
    // The merged value is 4 and the moving tile's value is 2.
    const leg = driveRun({
      seed: RUN_SEED,
      board: copyBoard(MERGE_PAIR_BOARD),
      moves: [DIRECTION_LEFT],
    });

    expect(leg.resolved).toEqual([true]);
    expect(leg.serialized.score).toBe(4);
  });
});

/* ==========================================================================
 * 3. Spawn accounting and the board walk
 * ========================================================================== */

describe('js/game_manager.js L62-L76 — addRandomTile', () => {
  it('takes two value draws and two position draws at setup', () => {
    const streams = createRngStreams(RUN_SEED);
    const engine = new Engine({
      config: createDefaultRulesConfig(),
      streams,
      storage: new LocalStorageManager({ storage: createBacking() }),
    });

    engine.setup();

    const cursors = streams.snapshotCursors();

    // L71 draws the value, then L72 draws the position, twice over for the two
    // start tiles of L7.
    expect(cursors['spawn-value']).toBe(2);
    expect(cursors['spawn-position']).toBe(2);
    expect(cursors['relic-draw']).toBe(0);
    expect(cursors['rarity-weight']).toBe(0);
  });

  it('takes one value draw and one position draw per resolved move', () => {
    const leg = driveRun({ seed: RUN_SEED });
    const resolvedTurns = leg.resolved.filter((moved) => moved).length;

    // L182-L183 spawn only where a position changed.
    expect(leg.cursors['spawn-value']).toBe(2 + resolvedTurns);
    expect(leg.cursors['spawn-position']).toBe(2 + resolvedTurns);
  });
});

describe('js/grid.js L45-L64 — availableCells traverses x then y', () => {
  it('lists the empty cells x-outer and y-inner', () => {
    const grid = new Grid(
      MERGE_PAIR_BOARD.grid.size,
      MERGE_PAIR_BOARD.grid.cells,
    );

    // MERGE_PAIR_BOARD holds its two tiles at (0,0) and (1,0), so those two
    // cells are the ones missing from this list.
    expect(grid.availableCells()).toEqual([
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 0, y: 3 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
      { x: 3, y: 0 },
      { x: 3, y: 1 },
      { x: 3, y: 2 },
      { x: 3, y: 3 },
    ]);
  });
});

describe('js/grid.js L80-L86 — cellContent off the lattice', () => {
  it('answers null beyond each of the four edges', () => {
    const size = BLOCKED_BOARD.grid.size;
    const grid = new Grid(size, BLOCKED_BOARD.grid.cells);

    expect(grid.cellContent({ x: -1, y: 0 })).toBeNull();
    expect(grid.cellContent({ x: 0, y: -1 })).toBeNull();
    expect(grid.cellContent({ x: size, y: 0 })).toBeNull();
    expect(grid.cellContent({ x: 0, y: size })).toBeNull();
  });

  it('answers the tile inside the lattice', () => {
    const grid = new Grid(
      MERGE_PAIR_BOARD.grid.size,
      MERGE_PAIR_BOARD.grid.cells,
    );
    const tile = grid.cellContent({ x: 0, y: 0 });

    expect(tile).not.toBeNull();
    expect(tile?.value).toBe(2);
    expect(grid.cellContent({ x: 0, y: 1 })).toBeNull();
  });
});

describe('js/grid.js L37-L43 — randomAvailableCell on a full board', () => {
  it('yields nothing and consumes no draw', () => {
    // NEAR_LOSS_BOARD fills all sixteen cells.
    const full = NEAR_LOSS_BOARD.grid;
    const grid = new Grid(full.size, full.cells);
    const stream = createRngStreams(RUN_SEED).stream('spawn-position');

    expect(grid.availableCells()).toEqual([]);
    expect(grid.cellsAvailable()).toBe(false);
    expect(grid.randomAvailableCell(stream)).toBeUndefined();
    expect(stream.cursor).toBe(0);
  });

  it('leaves the cursor where it stood when pick is given no candidate', () => {
    const stream = createRngStreams(RUN_SEED).stream('spawn-position');

    stream.next();

    expect(stream.cursor).toBe(1);
    expect(stream.pick([])).toBeUndefined();
    expect(stream.cursor).toBe(1);
  });
});

describe('js/game_manager.js L134 — the terminal-state guard', () => {
  it('refuses a further move and consumes no randomness', () => {
    const leg = driveRun({
      seed: RUN_SEED,
      board: copyBoard(NEAR_LOSS_BOARD),
      moves: TERMINAL_MOVE_LIST,
    });

    expect(leg.engine.isGameTerminated()).toBe(true);
    expect(leg.engine.over).toBe(true);
    expect(movesAvailable(leg.engine.grid, leg.engine.config)).toBe(false);

    const before = leg.engine.serialize();

    expect(leg.engine.move(DIRECTION_UP)).toBe(false);
    expect(leg.engine.move(DIRECTION_RIGHT)).toBe(false);
    expect(leg.engine.move(DIRECTION_DOWN)).toBe(false);
    expect(leg.engine.move(DIRECTION_LEFT)).toBe(false);
    expect(leg.engine.serialize()).toEqual(before);
    expect(leg.streams.snapshotCursors()).toEqual(leg.cursors);
  });
});

describe('js/game_manager.js L170 — won is raised at the win value', () => {
  it('raises won where a merge reaches the configured value', () => {
    // NEAR_WIN_BOARD holds two tiles of half the win value, so one move
    // produces 2048 through the L157 producer.
    const leg = driveRun({
      seed: RUN_SEED,
      board: copyBoard(NEAR_WIN_BOARD),
    });

    expect(leg.serialized.won).toBe(true);
    expect(leg.serialized.keepPlaying).toBe(false);
    expect(leg.engine.isGameTerminated()).toBe(true);
  });
});

/* ==========================================================================
 * 4. The recorded boards — AAP V1
 * ========================================================================== */

describe('js/game_manager.js L102-L110 — serialize()', () => {
  it('carries the five frozen members, keepPlaying among them', () => {
    const leg = driveRun({ seed: RUN_SEED });

    // The in-class flag was renamed by the I15 repair; the persisted member
    // name is unchanged.
    expect(Object.keys(leg.serialized).sort()).toEqual([
      'grid',
      'keepPlaying',
      'over',
      'score',
      'won',
    ]);
    expect(leg.serialized.grid.size).toBe(VANILLA_BOARD_SIZE);
  });

  it('reproduces its recorded board from a fresh start', () => {
    expect(renderLeg(driveRun({ seed: RUN_SEED }))).toMatchSnapshot(
      'fresh board',
    );
  });
});

describe('js/game_manager.js L36-L45 — a restored run', () => {
  it('reproduces its recorded board from the empty fixture', () => {
    expect(
      renderLeg(driveRun({ seed: RUN_SEED, board: copyBoard(EMPTY_BOARD) })),
    ).toMatchSnapshot('restored from the empty fixture');
  });

  it('reproduces its recorded board from the merge-pair fixture', () => {
    expect(
      renderLeg(
        driveRun({ seed: RUN_SEED, board: copyBoard(MERGE_PAIR_BOARD) }),
      ),
    ).toMatchSnapshot('restored from the merge-pair fixture');
  });

  it('reproduces its recorded board from the blocked fixture', () => {
    expect(
      renderLeg(driveRun({ seed: RUN_SEED, board: copyBoard(BLOCKED_BOARD) })),
    ).toMatchSnapshot('restored from the blocked fixture');
  });

  it('reproduces its recorded board from the near-win fixture', () => {
    expect(
      renderLeg(driveRun({ seed: RUN_SEED, board: copyBoard(NEAR_WIN_BOARD) })),
    ).toMatchSnapshot('restored from the near-win fixture');
  });

  it('reproduces its recorded board from the near-loss fixture', () => {
    expect(
      renderLeg(
        driveRun({ seed: RUN_SEED, board: copyBoard(NEAR_LOSS_BOARD) }),
      ),
    ).toMatchSnapshot('restored from the near-loss fixture');
  });
});

/* ==========================================================================
 * 5. One seed and one move list, twice — AAP V2
 * ========================================================================== */

describe('AAP V2 — two engines from one seed and one move list', () => {
  it('reaches the same board, the same cursors and the same turns', () => {
    const first = driveRun({ seed: RUN_SEED });
    const second = driveRun({ seed: RUN_SEED });

    expect(second.serialized).toEqual(first.serialized);
    expect(second.cursors).toEqual(first.cursors);
    expect(second.resolved).toEqual(first.resolved);
  });

  it('reproduces the board recorded for that seed', () => {
    expect(renderLeg(driveRun({ seed: RUN_SEED }))).toMatchSnapshot(
      'second engine, same seed',
    );
  });

  it('reaches a different board from a different seed', () => {
    const first = driveRun({ seed: RUN_SEED });
    const other = driveRun({ seed: OTHER_RUN_SEED });

    expect(other.serialized).not.toEqual(first.serialized);
  });
});

describe('createSeededRng — a start cursor fast-forwards', () => {
  it('stands where an instance advanced by that many draws stands', () => {
    const seed = 'fast-forward-seed';
    const advanced = createSeededRng(seed);
    const skipped = 3;

    for (let draw = 0; draw < skipped; draw += 1) {
      advanced.next();
    }

    const jumped = createSeededRng(seed, skipped);

    expect(jumped.cursor).toBe(advanced.cursor);

    const fromAdvanced: number[] = [];
    const fromJumped: number[] = [];

    for (let draw = 0; draw < skipped; draw += 1) {
      fromAdvanced.push(advanced.next());
      fromJumped.push(jumped.next());
    }

    expect(fromJumped).toEqual(fromAdvanced);
    expect(jumped.cursor).toBe(skipped * 2);
  });
});

/* ==========================================================================
 * 6. The same run across a reload — AAP V2
 * ========================================================================== */

/** What the interrupted half of the reload leg produced. */
interface Interruption {
  readonly backing: MemoryStorage;
  readonly envelope: RunState;
  readonly halfway: SerializedGameState;
}

/**
 * Plays the first `MOVES_BEFORE_RELOAD` moves and persists the run through
 * `RunStateStore`.
 */
function interruptRun(): Interruption {
  const backing = createBacking();
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const streams = createRngStreams(RUN_SEED);
  const engine = new Engine({ config, streams, storage: manager });

  engine.setup();

  for (const direction of MOVE_LIST.slice(0, MOVES_BEFORE_RELOAD)) {
    engine.move(direction);
  }

  const halfway = engine.serialize();
  const envelope = createFreshRunState({
    runId: FIXED_RUN_ID,
    seed: RUN_SEED,
    rngCursor: streams.snapshotCursors(),
    stageIndex: 0,
    stageGoal: stageGoalForIndex(0, createDefaultStageConfig()),
    board: halfway,
  });

  const written = new RunStateStore({ storage: manager, config }).save(
    envelope,
  );

  expect(written).toBe(true);

  return { backing, envelope, halfway };
}

/**
 * Reads the envelope back through a reader stack built after the write, and
 * plays the remaining moves.
 *
 * js/local_storage_manager.js L25-L26 probed Web Storage once at construction
 * and js/game_manager.js L36 read the snapshot once at setup, so the manager,
 * the store and the engine are all constructed after the fixture is in place.
 */
function resumeRun(backing: MemoryStorage): RunLeg {
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const loaded = new RunStateStore({ storage: manager, config }).load();

  expect(loaded.outcome).toBe('loaded');
  expect(loaded.verdict).toBe('current');

  const envelope = loaded.state;

  if (envelope === null) {
    throw new Error('the persisted run envelope was refused on load');
  }

  const streams = createRngStreams(envelope.seed, envelope.rngCursor);
  const engine = new Engine({ config, streams, storage: manager });

  engine.setup(envelope.board);

  const resolved: boolean[] = [];

  for (const direction of MOVE_LIST.slice(MOVES_BEFORE_RELOAD)) {
    resolved.push(engine.move(direction));
  }

  return {
    engine,
    streams,
    serialized: engine.serialize(),
    cursors: streams.snapshotCursors(),
    resolved,
  };
}

describe('AAP Contract 5 — the persisted run envelope', () => {
  it('wraps the legacy board snapshot verbatim', () => {
    const interrupted = interruptRun();

    expect(interrupted.envelope.board).toEqual(interrupted.halfway);
    expect(Object.keys(interrupted.envelope.board).sort()).toEqual([
      'grid',
      'keepPlaying',
      'over',
      'score',
      'won',
    ]);
  });

  it('carries a schema version and a cursor for every substream', () => {
    const interrupted = interruptRun();

    expect(interrupted.envelope.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(interrupted.envelope.runId).toBe(FIXED_RUN_ID);
    expect(interrupted.envelope.seed).toBe(RUN_SEED);

    for (const name of RNG_STREAM_NAMES) {
      expect(typeof interrupted.envelope.rngCursor[name]).toBe('number');
    }

    expect(Object.keys(interrupted.envelope.rngCursor).sort()).toEqual(
      [...RNG_STREAM_NAMES].sort(),
    );
  });

  it('reproduces its recorded envelope', () => {
    expect(projectEnvelope(interruptRun().envelope)).toMatchSnapshot(
      'envelope at the interruption',
    );
  });
});

describe('AAP V2 — a run interrupted and resumed from storage', () => {
  it('reaches the board the uninterrupted run reached', () => {
    const straight = driveRun({ seed: RUN_SEED });
    const resumed = resumeRun(interruptRun().backing);

    expect(resumed.serialized).toEqual(straight.serialized);
  });

  it('reaches the cursors the uninterrupted run reached', () => {
    const straight = driveRun({ seed: RUN_SEED });
    const resumed = resumeRun(interruptRun().backing);

    expect(resumed.cursors).toEqual(straight.cursors);
  });

  it('reproduces the recorded board after the resume', () => {
    expect(renderLeg(resumeRun(interruptRun().backing))).toMatchSnapshot(
      'resumed run',
    );
  });
});

/* ==========================================================================
 * 7. The relic offers one seed draws — AAP V2
 * ========================================================================== */

describe('AAP V2 — the reward offers of one seed', () => {
  it('reproduces its recorded offer sequence', () => {
    // Identifiers alone, not whole relic objects.
    expect(
      projectOfferSets(
        drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE),
      ),
    ).toMatchSnapshot('catalogue offer ids by stage');
  });

  it('offers no identifier twice within one set', () => {
    const sets = drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE);

    expect(sets).toHaveLength(OFFER_SET_COUNT);

    for (const ids of sets) {
      expect(ids).toHaveLength(OFFERS_PER_SET);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('reproduces the sequence from a second generator on that seed', () => {
    expect(drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE)).toEqual(
      drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE),
    );
  });

  it('excludes an owned identifier from every later set', () => {
    const sets = drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE);
    const owned: string[] = [];

    for (const ids of sets) {
      for (const held of owned) {
        expect(ids).not.toContain(held);
      }

      const taken = ids[0];

      if (taken !== undefined) {
        owned.push(taken);
      }
    }

    expect(owned).toHaveLength(OFFER_SET_COUNT);
    expect(new Set(owned).size).toBe(owned.length);
  });

  it('draws one relic-draw and one rarity-weight per offer', () => {
    const streams = createRngStreams(RUN_SEED);
    const sets = drawOfferSets(streams, RELIC_CATALOGUE);
    const offered = sets.reduce((total, ids) => total + ids.length, 0);
    const cursors = streams.snapshotCursors();

    expect(cursors['relic-draw']).toBe(offered);
    expect(cursors['rarity-weight']).toBe(offered);

    // The board substreams are untouched by a reward draw.
    expect(cursors['spawn-value']).toBe(0);
    expect(cursors['spawn-position']).toBe(0);
  });
});

/* ==========================================================================
 * 8. The properties the published figures rest on
 * ========================================================================== */

describe('AAP Contract 6 — the four substreams are independent', () => {
  it('leaves the board and the spawn cursors at the baseline', () => {
    const baseline = driveRun({ seed: RUN_SEED });
    const noisy = driveRun({
      seed: RUN_SEED,
      betweenMoves: (streams) => {
        drawRelicOffers({
          pool: HAND_BUILT_POOL,
          count: INTERLEAVED_OFFER_COUNT,
          streams,
        });
      },
    });

    expect(noisy.serialized).toEqual(baseline.serialized);
    expect(noisy.serialized.score).toBe(baseline.serialized.score);
    expect(noisy.resolved).toEqual(baseline.resolved);
    expect(projectBoard(noisy.serialized)).toBe(
      projectBoard(baseline.serialized),
    );
    expect(noisy.cursors['spawn-value']).toBe(baseline.cursors['spawn-value']);
    expect(noisy.cursors['spawn-position']).toBe(
      baseline.cursors['spawn-position'],
    );

    // The interleaved draws were taken.
    expect(noisy.cursors['relic-draw']).toBeGreaterThan(
      baseline.cursors['relic-draw'],
    );
    expect(noisy.cursors['rarity-weight']).toBeGreaterThan(
      baseline.cursors['rarity-weight'],
    );
  });

  it('draws the same hand-built offers whatever the board consumed', () => {
    const bare = createRngStreams(RUN_SEED);
    const played = driveRun({ seed: RUN_SEED }).streams;

    expect(
      drawOfferSets(played, HAND_BUILT_POOL),
    ).toEqual(drawOfferSets(bare, HAND_BUILT_POOL));
  });
});

describe('AAP Contract 2 — dispatch follows pickup order', () => {
  /** Two subscribers on one hook, in a fixed pickup order. */
  function createOrderedBus(record: string[]): HookBus {
    const bus = createHookBus();

    // Registered without a pickupOrder, so each is appended to the end of the
    // order: 'first' then 'second'.
    for (const id of ['first', 'second']) {
      expect(
        bus.register({
          id,
          hooks: {
            onSpawn: (): void => {
              record.push(id);
            },
          },
        }),
      ).toBe(true);
    }

    return bus;
  }

  it('invokes both subscribers, in pickup order, on every spawn', () => {
    const record: string[] = [];
    const leg = driveRun({ seed: RUN_SEED, hooks: createOrderedBus(record) });

    expect(record.length).toBeGreaterThan(0);
    expect(record.length % 2).toBe(0);

    for (let index = 0; index < record.length; index += 2) {
      expect(record[index]).toBe('first');
      expect(record[index + 1]).toBe('second');
    }

    // One dispatch pair per spawn, and a spawn per start tile and per resolved
    // move.
    expect(record.length).toBe(leg.cursors['spawn-value'] * 2);
  });

  it('reproduces the run for the same pickup order', () => {
    const firstRecord: string[] = [];
    const secondRecord: string[] = [];
    const first = driveRun({
      seed: RUN_SEED,
      hooks: createOrderedBus(firstRecord),
    });
    const second = driveRun({
      seed: RUN_SEED,
      hooks: createOrderedBus(secondRecord),
    });

    expect(secondRecord).toEqual(firstRecord);
    expect(second.serialized).toEqual(first.serialized);
    expect(second.cursors).toEqual(first.cursors);
  });

  it('reproduces the recorded board and dispatch order', () => {
    const record: string[] = [];
    const leg = driveRun({ seed: RUN_SEED, hooks: createOrderedBus(record) });

    expect(
      [
        renderLeg(leg),
        'dispatch order, one line per spawn',
        projectDispatchPairs(record),
      ].join('\n'),
    ).toMatchSnapshot('pickup-ordered dispatch');
  });

  it('leaves the baseline board unchanged', () => {
    const record: string[] = [];
    const bus = createOrderedBus(record);
    const hooked = driveRun({ seed: RUN_SEED, hooks: bus });

    expect(hooked.serialized).toEqual(driveRun({ seed: RUN_SEED }).serialized);
  });
});

describe('AAP Contract 6 — the platform generator is never patched', () => {
  it('captured the platform implementation, not an installed one', () => {
    // A replacement would be an ordinary function, whose source is its body.
    expect(Function.prototype.toString.call(PLATFORM_MATH_RANDOM)).toContain(
      '[native code]',
    );
  });

  it('holds that exact reference after a run, a draw and a reload', () => {
    driveRun({ seed: RUN_SEED });
    drawOfferSets(createRngStreams(RUN_SEED), RELIC_CATALOGUE);
    resumeRun(interruptRun().backing);

    const { random: platformRandomNow } = Math;

    expect(platformRandomNow).toBe(PLATFORM_MATH_RANDOM);
  });

  it('holds the descriptor the platform installed it under', () => {
    driveRun({ seed: RUN_SEED });

    // A replacement made through Object.defineProperty rather than by
    // assignment changes the descriptor even where the functions compare equal.
    expect(Object.getOwnPropertyDescriptor(Math, 'random')).toEqual(
      PLATFORM_MATH_RANDOM_DESCRIPTOR,
    );
  });
});

describe('AAP Rule 3 — an appended subscriber is omittable', () => {
  it('leaves the board and the cursors identical to the baseline', () => {
    const baseline = driveRun({ seed: RUN_SEED });
    const seen: string[] = [];
    const watched = driveRun({
      seed: RUN_SEED,
      attach: (engine) => {
        for (const name of ENGINE_EVENT_NAMES) {
          engine.events.on(name, () => {
            seen.push(name);
          });
        }
      },
    });

    expect(seen.length).toBeGreaterThan(0);
    expect(watched.serialized).toEqual(baseline.serialized);
    expect(watched.cursors).toEqual(baseline.cursors);
    expect(renderLeg(watched)).toBe(renderLeg(baseline));
  });
});

/* ==========================================================================
 * 9. Teardown
 * ========================================================================== */

describe('js/local_storage_manager.js L22 — the best-score key', () => {
  it('is one of the keys the teardown iterates', () => {
    expect(OWNED_STORAGE_KEYS).toContain(BEST_SCORE_KEY);
  });

  it('reads back as the stored string and is removed by the teardown', () => {
    const backing = createBacking();
    const manager = new LocalStorageManager({ storage: backing });

    expect(manager.setBestScore(1024)).toBe(true);

    // L43-L45 returned the stored value with no conversion.
    expect(manager.getBestScore()).toBe('1024');

    clearInjectedStores();

    expect(backing.getItem(BEST_SCORE_KEY)).toBeUndefined();
  });
});
