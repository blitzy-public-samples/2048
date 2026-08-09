// Isolation suite for the `spawn-control` relic `fertile-ground`, the one
// relic of its family that writes the lattice. AAP R3, and the three
// properties AAP 0.6.3 Group 5 requires of every relic: the hooks it binds,
// the effect it produces, and its relationship to `charges`.
//
// This suite reads no DOM, no storage and no clock, opens no server, browser
// or network connection, takes no draw from the global random source, and
// installs no fake timer and no mock library.
//
// Decisions: DL-SPAWN-01, DL-SPAWN-02, DL-RELIC-01 (docs/DECISION_LOG.md).

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  BoardEffect,
  BoardEffectQueue,
  HookContext,
  HookHandler,
  ReadonlyGridView,
  SpawnPayload,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import type {
  CorrelationId,
  Position,
  SerializedGameState,
  SerializedGrid,
} from '../../../src/engine/types';
import {
  SPAWN_CONTROL_FAMILY,
} from '../../../src/relics/families/spawn-control';
import { findRelicById } from '../../../src/relics/relic-registry';
import { RARITIES } from '../../../src/relics/relic-types';
import type { Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type {
  RngCursorMap,
  RngStreams,
} from '../../../src/rng/rng-streams';
import {
  createEmptyBoard,
  createMergePairBoard,
  createNearLossBoard,
} from '../../fixtures/boards';

/** Identifier the family declares the relic under test with. */
const RELIC_ID = 'fertile-ground';

/** Name the declaration carries. */
const RELIC_NAME = 'Fertile Ground';

/**
 * Seed every bench derives its substreams from unless a case names another.
 */
const SEED = 'fertile-ground-suite';

/** Run correlation identifier every dispatch below carries. */
const CORRELATION_ID: CorrelationId = 'run-fertile-ground-suite';

/** How many seeds each of the three sweep cases below walks. */
const SWEEP_SIZE = 24;

/** The five members `Relic` declares for a relic carrying no charge budget. */
const DECLARED_MEMBERS: readonly string[] = [
  'description',
  'hooks',
  'id',
  'name',
  'rarity',
];

/** Identifiers of the four `spawn-control` relics, in declaration order. */
const FAMILY_ORDER: readonly string[] = [
  'twin-seed',
  'fertile-ground',
  'prospectors-eye',
  'loaded-dice',
];

/**
 * The declaration under test, read from the catalogue by identifier.
 *
 * @returns The declaration.
 */
function relic(): Relic {
  const found = findRelicById(RELIC_ID);

  expect(found, `the catalogue publishes ${RELIC_ID}`).toBeDefined();

  if (found === undefined) {
    throw new Error(`The relic catalogue carries no ${RELIC_ID}.`);
  }

  return found;
}

/**
 * The `onSpawn` handler under test.
 *
 * @returns The bound handler.
 */
function spawnHandler(): HookHandler<'onSpawn'> {
  const handler = relic().hooks.onSpawn;

  expect(handler, `${RELIC_ID} binds onSpawn`).toBeTypeOf('function');

  if (handler === undefined) {
    throw new Error(`${RELIC_ID} binds no onSpawn handler.`);
  }

  return handler;
}

/**
 * The handler's source text, as the transform under test emitted it.
 *
 * @returns The text `Function.prototype.toString` yields.
 */
function handlerSource(): string {
  return spawnHandler().toString();
}

/**
 * Fingerprint of the declaration, read at module load and again in section 10.
 *
 * @param declaration Declaration to fingerprint.
 * @returns A plain record carrying every declared member that is data.
 */
function fingerprint(declaration: Relic): Record<string, unknown> {
  return {
    id: declaration.id,
    name: declaration.name,
    rarity: declaration.rarity,
    description: declaration.description,
    hooks: Object.keys(declaration.hooks),
    members: Object.keys(declaration).sort(),
    frozen: Object.isFrozen(declaration),
    hooksFrozen: Object.isFrozen(declaration.hooks),
  };
}

/** The fingerprint as the suite found it, before any case has run. */
const FOUND_AS: Record<string, unknown> = fingerprint(relic());

/** One occupied cell, as an assertion below reads it. */
interface Occupant {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/** One tile held on the board, with the cell it was found in. */
interface Held {
  readonly cell: Position;
  readonly tile: Tile;
  readonly value: number;
}

/**
 * Builds a live board from a fixture.
 *
 * @param board Fixture board, freshly built and unfrozen.
 * @returns A live grid holding one tile per non-null fixture cell.
 */
function gridOf(board: SerializedGameState): Grid {
  return new Grid(board.grid.size, board.grid.cells);
}

/**
 * Keys one cell for set membership and for a failure message.
 *
 * @param cell Cell to key.
 * @returns The cell as `x,y`.
 */
function cellKey(cell: Position): string {
  return `${String(cell.x)},${String(cell.y)}`;
}

/**
 * Orders two tile values low to high, which `Array.prototype.sort` does not do
 * for numbers without a comparator.
 *
 * @param left First value.
 * @param right Second value.
 * @returns A negative number, zero, or a positive number.
 */
function ascending(left: number, right: number): number {
  return left - right;
}

/**
 * Lists the occupied cells of a board, x-outer and y-inner.
 *
 * @param grid Board to read.
 * @returns A fresh array of fresh records.
 */
function occupants(grid: Grid): Occupant[] {
  const found: Occupant[] = [];

  grid.eachCell((_x, _y, tile): void => {
    if (tile !== null) {
      found.push({ x: tile.x, y: tile.y, value: tile.value });
    }
  });

  return found;
}

/**
 * Lists the live tiles of a board with the cells they were found in.
 *
 * @param grid Board to read.
 * @returns A fresh array holding the live tile objects.
 */
function heldTiles(grid: Grid): Held[] {
  const found: Held[] = [];

  grid.eachCell((x, y, tile): void => {
    if (tile !== null) {
      found.push({ cell: { x, y }, tile, value: tile.value });
    }
  });

  return found;
}

/**
 * Reads the empty cells of a board as a membership set.
 *
 * @param grid Board to read.
 * @returns The keys of every empty cell.
 */
function availableKeys(grid: Grid): Set<string> {
  return new Set(grid.availableCells().map(cellKey));
}

/**
 * Inserts a tile through the public lattice write of js/grid.js L89-L91.
 *
 * @param grid Board to write.
 * @param x Column to write.
 * @param y Row to write.
 * @param value Face value the tile carries.
 */
function place(grid: Grid, x: number, y: number, value: number): void {
  grid.insertTile(new Tile({ x, y }, value));
}

/**
 * Removes whatever tile a cell holds, through js/grid.js L93-L95.
 *
 * @param grid Board to write.
 * @param cell Cell to clear.
 */
function clearCell(grid: Grid, cell: Position): void {
  const tile = grid.cellContent(cell);

  expect(tile, `the fixture holds a tile at ${cellKey(cell)}`).not.toBeNull();

  if (tile !== null) {
    grid.removeTile(tile);
  }
}

/**
 * Asserts a board is internally consistent: square, every slot holding either
 * `null` or a `Tile` whose own coordinates match the slot it sits in, and
 * js/grid.js L80-L86's off-lattice read still yielding `null`.
 *
 * @param grid Board to read.
 */
function expectCoherentLattice(grid: Grid): void {
  expect(grid.cells).toHaveLength(grid.size);

  for (let x = 0; x < grid.size; x += 1) {
    const column = grid.cells[x];

    expect(column).toHaveLength(grid.size);

    for (let y = 0; y < grid.size; y += 1) {
      const slot = column[y];

      expect(slot === null || slot instanceof Tile).toBe(true);

      if (slot !== null) {
        const key = cellKey({ x, y });

        expect(slot.x, `the tile at ${key} knows its column`).toBe(x);
        expect(slot.y, `the tile at ${key} knows its row`).toBe(y);
      }
    }
  }

  expect(grid.cellContent({ x: grid.size, y: 0 })).toBeNull();
  expect(grid.cellContent({ x: 0, y: grid.size })).toBeNull();
  expect(grid.cellContent({ x: -1, y: 0 })).toBeNull();
}

/**
 * Asserts every tile listed is still the same object, in the same cell, at the
 * same value.
 *
 * @param grid Board to read.
 * @param before Tiles held before the dispatch under test.
 */
function expectHeldUndisturbed(grid: Grid, before: readonly Held[]): void {
  for (const entry of before) {
    const key = cellKey(entry.cell);

    expect(grid.cellContent(entry.cell), `the tile at ${key}`).toBe(entry.tile);
    expect(entry.tile.x, `the column of the tile at ${key}`)
      .toBe(entry.cell.x);
    expect(entry.tile.y, `the row of the tile at ${key}`).toBe(entry.cell.y);
    expect(entry.tile.value, `the value of the tile at ${key}`)
      .toBe(entry.value);
  }
}

/**
 * Asserts a board round-trips through js/grid.js L102-L117: a fresh `{ size,
 * cells }` projection, square, with an empty cell kept as `null`, from which
 * js/grid.js L21-L34 rebuilds the same occupancy.
 *
 * @param grid Board to project and rebuild.
 */
function expectSerialisationRoundTrip(grid: Grid): void {
  const snapshot: SerializedGrid = grid.serialize();

  expect(snapshot.size).toBe(grid.size);
  expect(snapshot.cells).toHaveLength(grid.size);

  for (let x = 0; x < grid.size; x += 1) {
    expect(snapshot.cells[x]).toHaveLength(grid.size);
  }

  expect(occupants(new Grid(snapshot.size, snapshot.cells)))
    .toEqual(occupants(grid));
}

/** One recorded insertion, narrowed out of the command union. */
type InsertCommand = Extract<BoardEffect, { kind: 'insertTile' }>;

/** A recording board-effect queue, and the writes its commands resolve to. */
interface TestEffects {
  /** The queue the dispatch context carries. */
  readonly queue: BoardEffectQueue;

  /** Commands recorded and not discarded, in record order. */
  recorded(): readonly BoardEffect[];

  /** The recorded insertions alone, in record order. */
  inserts(): readonly InsertCommand[];

  /**
   * Writes every recorded command to the live board and rules, in record order
   * and through the public API alone: js/grid.js L89-L91 `insertTile`, L93-L95
   * `removeTile` and js/tile.js L10-L17 `savePosition`/`updatePosition`.
   *
   * @returns How many commands were written.
   */
  apply(): number;
}

/**
 * Reports whether a value is a face value a tile can carry.
 *
 * @param value Value to test.
 * @returns `true` for a positive safe integer.
 */
function isFaceValue(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Reports whether a weight list can be drawn from.
 *
 * @param weights Weights to test.
 * @returns `true` when every weight is finite and non-negative and at least
 *   one is above zero.
 */
function isDrawable(weights: readonly number[]): boolean {
  return (
    weights.length > 0 &&
    weights.every((weight) => Number.isFinite(weight) && weight >= 0) &&
    weights.some((weight) => weight > 0)
  );
}

/**
 * Writes one recorded command to a live board and the rules in force.
 *
 * @param effect Command to write.
 * @param grid Board to write.
 * @param config Rules to write.
 * @returns Whether the command was written.
 */
function applyEffect(
  effect: BoardEffect,
  grid: Grid,
  config: RulesConfig,
): boolean {
  switch (effect.kind) {
    case 'insertTile': {
      // js/tile.js L1-L8 flattens the cell onto the tile; js/grid.js L89-L91
      // then indexes the slot by the tile's own `x` and `y`.
      grid.insertTile(new Tile(effect.cell, effect.value));

      return true;
    }

    case 'removeTile': {
      const tile = grid.cellContent(effect.cell);

      if (tile === null) {
        return false;
      }

      grid.removeTile(tile);

      return true;
    }

    case 'moveTile': {
      const tile = grid.cellContent(effect.from);

      if (tile === null) {
        return false;
      }

      if (effect.tween) {
        tile.savePosition();
      }

      grid.removeTile(tile);
      tile.updatePosition(effect.to);
      grid.insertTile(tile);

      return true;
    }

    case 'setMergePredicate': {
      config.merge.canMerge = effect.predicate;

      return true;
    }

    case 'setSpawnWeights': {
      config.spawn.weights = effect.weights.slice();

      return true;
    }

    default:
      return false;
  }
}

/**
 * Opens a recording queue over a live board and the rules in force.
 *
 * @param grid Live board the queue projects from and writes to.
 * @param config Live rules a rules command writes.
 * @returns The queue, its records, and the writer that resolves them.
 */
function openTestEffects(grid: Grid, config: RulesConfig): TestEffects {
  const recorded: BoardEffect[] = [];
  const overlay = new Map<string, number | null>();
  let refusals = 0;

  const projected = (cell: Position): number | null => {
    if (!grid.withinBounds(cell)) {
      return null;
    }

    const key = cellKey(cell);

    if (overlay.has(key)) {
      return overlay.get(key) ?? null;
    }

    return grid.cellContent(cell)?.value ?? null;
  };

  const record = (effect: BoardEffect): boolean => {
    recorded.push(effect);

    return true;
  };

  const refuse = (): boolean => {
    refusals += 1;

    return false;
  };

  const queue: BoardEffectQueue = {
    get size(): number {
      return grid.size;
    },

    get length(): number {
      return recorded.length;
    },

    get refused(): number {
      return refusals;
    },

    insertTile(cell, value) {
      if (!grid.withinBounds(cell) || projected(cell) !== null) {
        return refuse();
      }

      if (!isFaceValue(value)) {
        return refuse();
      }

      overlay.set(cellKey(cell), value);

      return record({
        kind: 'insertTile',
        cell: { x: cell.x, y: cell.y },
        value,
      });
    },

    removeTile(cell) {
      if (projected(cell) === null) {
        return refuse();
      }

      overlay.set(cellKey(cell), null);

      return record({ kind: 'removeTile', cell: { x: cell.x, y: cell.y } });
    },

    moveTile(from, to, tween = true) {
      const value = projected(from);

      if (value === null || !grid.withinBounds(to)) {
        return refuse();
      }

      if (projected(to) !== null) {
        return refuse();
      }

      overlay.set(cellKey(from), null);
      overlay.set(cellKey(to), value);

      return record({
        kind: 'moveTile',
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
        tween,
      });
    },

    restoreBoard: (): boolean => refuse(),

    resizeBoard: (): boolean => refuse(),

    setMergePredicate(predicate) {
      return typeof predicate === 'function'
        ? record({ kind: 'setMergePredicate', predicate })
        : refuse();
    },

    setSpawnWeights(weights) {
      return isDrawable(weights)
        ? record({ kind: 'setSpawnWeights', weights: weights.slice() })
        : refuse();
    },

    request(effect) {
      switch (effect.kind) {
        case 'insertTile':
          return queue.insertTile(effect.cell, effect.value);
        case 'removeTile':
          return queue.removeTile(effect.cell);
        case 'moveTile':
          return queue.moveTile(effect.from, effect.to, effect.tween);
        case 'setMergePredicate':
          return queue.setMergePredicate(effect.predicate);
        case 'setSpawnWeights':
          return queue.setSpawnWeights(effect.weights);
        default:
          return refuse();
      }
    },

    requested(): readonly BoardEffect[] {
      return Object.freeze(recorded.slice());
    },

    cellValue(cell) {
      return projected(cell);
    },

    cellOccupied(cell) {
      return projected(cell) !== null;
    },

    availableCells(): Position[] {
      const cells: Position[] = [];

      for (let x = 0; x < grid.size; x += 1) {
        for (let y = 0; y < grid.size; y += 1) {
          if (projected({ x, y }) === null) {
            cells.push({ x, y });
          }
        }
      }

      return cells;
    },

    occupiedCells() {
      const cells: Occupant[] = [];

      for (let x = 0; x < grid.size; x += 1) {
        for (let y = 0; y < grid.size; y += 1) {
          const value = projected({ x, y });

          if (value !== null) {
            cells.push({ x, y, value });
          }
        }
      }

      return cells;
    },

    clear(): void {
      recorded.length = 0;
      overlay.clear();
    },
  };

  return {
    queue,

    recorded(): readonly BoardEffect[] {
      return queue.requested();
    },

    inserts(): readonly InsertCommand[] {
      return recorded.filter(
        (effect): effect is InsertCommand => effect.kind === 'insertTile',
      );
    },

    apply(): number {
      let written = 0;

      for (const effect of recorded) {
        if (applyEffect(effect, grid, config)) {
          written += 1;
        }
      }

      return written;
    },
  };
}

/** One assembled dispatch: its collaborators, its context and its requests. */
interface Bench {
  readonly grid: Grid;
  readonly config: RulesConfig;
  readonly streams: RngStreams;
  readonly effects: TestEffects;
  readonly context: HookContext;

  /** Amounts passed to `HookContext.spendCharge`, in call order. */
  readonly chargeRequests: number[];
}

/** What a bench accepts besides its board. */
interface BenchOptions {
  /** Seed the substreams are derived from. Defaults to `SEED`. */
  readonly seed?: string;

  /** Charges the notional subscription holds. Absent for no budget. */
  readonly charges?: number;

  /** Initial value of the subscriber's state slot. */
  readonly state?: unknown;
}

/**
 * Builds the query-only board view a handler is handed.
 *
 * @param grid Live board to read through.
 * @returns The frozen view, reading the board at call time.
 */
function readonlyGrid(grid: Grid): ReadonlyGridView {
  return Object.freeze({
    get size(): number {
      return grid.size;
    },

    withinBounds: (position: Position): boolean => grid.withinBounds(position),
    cellAvailable: (cell: Position): boolean => grid.cellAvailable(cell),
    cellOccupied: (cell: Position): boolean => grid.cellOccupied(cell),
    cellValue: (cell: Position): number | null =>
      grid.cellContent(cell)?.value ?? null,
    availableCells: (): Position[] => grid.availableCells(),
    cellsAvailable: (): boolean => grid.cellsAvailable(),
    serialize: (): SerializedGrid => grid.serialize(),
  });
}

/**
 * Assembles one dispatch over a live board: fresh rules, substreams derived
 * from a fixed literal seed, a recording effect queue, the run correlation
 * identifier, and the subscriber's own mutable state slot.
 *
 * @param grid Live board the dispatch reads and its commands write.
 * @param options Seed, charge budget and initial state slot.
 * @returns The assembled bench.
 */
function bench(grid: Grid, options: BenchOptions = {}): Bench {
  const config = createDefaultRulesConfig();
  const streams = createRngStreams(options.seed ?? SEED);
  const effects = openTestEffects(grid, config);
  const chargeRequests: number[] = [];

  const context: HookContext = {
    config,
    rng: streams,
    grid: readonlyGrid(grid),
    effects: effects.queue,
    correlationId: CORRELATION_ID,
    hook: 'onSpawn',
    subscriberId: RELIC_ID,
    pickupOrder: 0,
    charges: options.charges,

    // A subscriber carrying no budget spends nothing, so the request is
    // recorded and answered `false`.
    spendCharge: (amount = 1): boolean => {
      chargeRequests.push(amount);

      return false;
    },

    state: options.state,
  };

  return { grid, config, streams, effects, context, chargeRequests };
}

/**
 * Builds one `onSpawn` payload.
 *
 * @param position Cell the engine resolved, or `undefined` for none.
 * @param value Face value the rules produced.
 * @returns The payload, carrying no count.
 */
function spawnPayload(
  position: Position | undefined,
  value: number,
): SpawnPayload {
  return position === undefined ? { value } : { position, value };
}

/**
 * Invokes the handler under test against a bench.
 *
 * @param target Bench to dispatch on.
 * @param payload Payload to hand the handler.
 * @returns Whatever the handler returned.
 */
function dispatchSpawn(
  target: Bench,
  payload: SpawnPayload,
): SpawnPayload | void {
  return spawnHandler()(payload, target.context);
}

/**
 * Invokes the handler once and asserts it did not throw.
 *
 * @param target Bench to dispatch on.
 * @param payload Payload to hand the handler.
 * @returns Whatever the handler returned.
 */
function dispatchWithoutThrowing(
  target: Bench,
  payload: SpawnPayload,
): SpawnPayload | void {
  let result: SpawnPayload | void = undefined;

  expect(() => {
    result = spawnHandler()(payload, target.context);
  }).not.toThrow();

  return result;
}

/**
 * Reads the draw count of every substream.
 *
 * @param target Bench whose substreams are read.
 * @returns A fresh total cursor map.
 */
function cursorsOf(target: Bench): RngCursorMap {
  return target.streams.snapshotCursors();
}

/**
 * Asserts the `relic-draw` cursor moved by exactly `relicDraws`, every other
 * substream standing where it stood.
 *
 * @param before Cursors read before the dispatch.
 * @param after Cursors read after it.
 * @param relicDraws Draws the effect is expected to have taken.
 */
function expectDraws(
  before: RngCursorMap,
  after: RngCursorMap,
  relicDraws: number,
): void {
  expect(after['relic-draw'] - before['relic-draw']).toBe(relicDraws);

  for (const name of RNG_STREAM_NAMES) {
    if (name === 'relic-draw') {
      continue;
    }

    expect(after[name], `the ${name} cursor`).toBe(before[name]);
  }
}

/**
 * Counts the empty cells a serialised board keeps as `null`, per js/grid.js
 * L102-L117.
 *
 * @param snapshot Projection to count.
 * @returns How many cells are `null`.
 */
function countNulls(snapshot: SerializedGrid): number {
  let empties = 0;

  for (const column of snapshot.cells) {
    for (const cell of column) {
      if (cell === null) {
        empties += 1;
      }
    }
  }

  return empties;
}

/**
 * Reports whether any orthogonal neighbour of a cell holds a tile, reading an
 * off-lattice neighbour as unoccupied exactly as js/grid.js L72-L78 does.
 *
 * @param grid Board to read.
 * @param cell Cell whose neighbours are read.
 * @returns `true` when at least one neighbour holds a tile.
 */
function hasOccupiedNeighbour(grid: Grid, cell: Position): boolean {
  const offsets: readonly Position[] = [
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ];

  return offsets.some((offset) =>
    grid.cellOccupied({ x: cell.x + offset.x, y: cell.y + offset.y }),
  );
}

/** Cell the engine resolved in the merge-pair scenario. */
const SPAWN_CELL: Position = { x: 3, y: 3 };

/** Face value the rules produced for that spawn. */
const SPAWN_VALUE = 2;

/** How many tiles the merge-pair fixture opens with. */
const MERGE_PAIR_TILES = 2;

/** How many tiles a board of the configured edge length holds when full. */
const FULL_BOARD_TILES = DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE;

/**
 * The three empty cells the merge-pair fixture leaves beside a tile, in
 * js/grid.js L45-L55 order and less the spawn cell, which the filter excludes.
 */
const MERGE_PAIR_CANDIDATES: readonly string[] = ['0,1', '1,1', '2,0'];

/** Edge length the two reduced-board cases write into the rules. */
const REDUCED_SIZE = 2;

/**
 * The six empty cells beside a tile in the reduced-board scenario while the
 * rules still carry the full board, in js/grid.js L45-L55 order.
 */
const FULL_BOARD_CANDIDATES: readonly string[] = [
  '0,1',
  '1,0',
  '1,2',
  '2,1',
  '2,3',
  '3,2',
];

/** Those of the six that lie inside a board of edge length `REDUCED_SIZE`. */
const REDUCED_BOARD_CANDIDATES: readonly string[] = ['0,1', '1,0'];

/**
 * Builds a bench over the merge-pair fixture: two tiles of 2 at (0, 0) and (1,
 * 0), every other cell empty.
 *
 * @param options Seed, charge budget and initial state slot.
 * @returns The assembled bench.
 */
function mergePairBench(options: BenchOptions = {}): Bench {
  return bench(gridOf(createMergePairBoard()), options);
}

/**
 * Seeds the two reduced-board sweeps walk, so both read the same sequence at
 * the two configured edge lengths.
 *
 * @param index Position in the sweep.
 * @returns The seed for that position.
 */
function quadrantSeed(index: number): string {
  return `${SEED}-quadrant-${String(index)}`;
}

/**
 * Runs the reduced-board scenario once: two tiles placed apart, the rules
 * written to `boardSize`, and one spawn dispatched from the corner.
 *
 * @param seed Seed the substreams are derived from.
 * @param boardSize Edge length written into the rules before the dispatch.
 * @returns The cell the sprout was recorded on, keyed.
 */
function reducedBoardSprout(seed: string, boardSize: number): string {
  const target = bench(gridOf(createEmptyBoard()), { seed });

  place(target.grid, 1, 1, 4);
  place(target.grid, 3, 3, 8);
  target.config.boardSize = boardSize;

  dispatchSpawn(target, spawnPayload({ x: 0, y: 0 }, SPAWN_VALUE));

  const recorded = target.effects.inserts();

  expect(recorded, `one sprout at seed ${seed}`).toHaveLength(1);
  expect(target.grid.withinBounds(recorded[0].cell)).toBe(true);
  expect(target.effects.apply()).toBe(1);
  expectCoherentLattice(target.grid);

  return cellKey(recorded[0].cell);
}

describe('the fertile-ground declaration', () => {
  it('carries the five members of the relic data shape and no others', () => {
    const declaration = relic();

    expect(Object.keys(declaration).sort()).toEqual(DECLARED_MEMBERS);
    expect(declaration.id).toBe(RELIC_ID);
    expect(declaration.name).toBe(RELIC_NAME);
    expect(RARITIES).toContain(declaration.rarity);
    expect(declaration.description.length).toBeGreaterThan(0);
  });

  it('is the object the spawn-control family declares second of four', () => {
    expect(SPAWN_CONTROL_FAMILY.name).toBe('spawn-control');
    expect(SPAWN_CONTROL_FAMILY.relics).toHaveLength(4);
    expect(SPAWN_CONTROL_FAMILY.relics.map((entry) => entry.id))
      .toEqual(FAMILY_ORDER);
    expect(SPAWN_CONTROL_FAMILY.relics[1]).toBe(relic());
  });

  it('binds exactly one hook, onSpawn, to a function', () => {
    const bound = Object.keys(relic().hooks);

    expect(bound).toEqual(['onSpawn']);
    expect(bound).toHaveLength(1);

    for (const name of bound) {
      expect(HOOK_NAMES, `${name} is a declared hook name`).toContain(name);
    }

    expect(relic().hooks.onSpawn).toBeTypeOf('function');
  });

  it('leaves the other five hook names absent from its handler table', () => {
    const table = relic().hooks;
    const unbound = HOOK_NAMES.filter((name) => name !== 'onSpawn');

    expect(unbound).toHaveLength(5);

    for (const name of unbound) {
      expect(name in table, `${name} is absent, not present and undefined`)
        .toBe(false);
      expect(Object.prototype.hasOwnProperty.call(table, name)).toBe(false);
    }
  });

  it('is frozen at the declaration and at the handler table', () => {
    expect(Object.isFrozen(relic())).toBe(true);
    expect(Object.isFrozen(relic().hooks)).toBe(true);
  });
});

describe('the fertile-ground effect on a spawn', () => {
  // A fresh board, fresh rules from `createDefaultRulesConfig` and fresh
  // substreams before every case.
  let target: Bench;

  beforeEach(() => {
    target = mergePairBench();
  });

  it('is dispatched carrying the run correlation identifier', () => {
    expect(target.context.correlationId).toBe(CORRELATION_ID);
    expect(target.context.correlationId.length).toBeGreaterThan(0);
    expect(target.context.hook).toBe('onSpawn');
    expect(target.context.subscriberId).toBe(RELIC_ID);
    expect(target.context.pickupOrder).toBe(0);
    expect(target.context.rng.seed).toBe(SEED);

    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));

    expect(target.effects.inserts()).toHaveLength(1);
    expect(target.context.correlationId).toBe(CORRELATION_ID);
  });

  it('records one insertion on a cell empty before the dispatch', () => {
    const empties = availableKeys(target.grid);

    expect(occupants(target.grid)).toHaveLength(MERGE_PAIR_TILES);
    expect(empties.size).toBe(FULL_BOARD_TILES - MERGE_PAIR_TILES);

    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));

    const recorded = target.effects.inserts();

    expect(recorded).toHaveLength(1);
    expect(target.effects.recorded()).toHaveLength(1);
    expect(target.effects.queue.refused).toBe(0);
    expect(empties.has(cellKey(recorded[0].cell))).toBe(true);

    expect(target.effects.apply()).toBe(1);
    expect(occupants(target.grid)).toHaveLength(MERGE_PAIR_TILES + 1);
    expectCoherentLattice(target.grid);
  });

  it('sprouts on one of the three cells beside the pair, never on the ' +
    'spawn cell', () => {
    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));

    const sprout = target.effects.inserts()[0].cell;

    expect(MERGE_PAIR_CANDIDATES).toContain(cellKey(sprout));
    expect(cellKey(sprout)).not.toBe(cellKey(SPAWN_CELL));
    expect(hasOccupiedNeighbour(target.grid, sprout)).toBe(true);
    expect(target.grid.cellAvailable(sprout)).toBe(true);
  });

  it('writes no cell while the handler runs', () => {
    const before = target.grid.serialize();

    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));

    expect(target.grid.serialize()).toEqual(before);
    expect(occupants(target.grid)).toHaveLength(MERGE_PAIR_TILES);
    expect(target.effects.inserts()).toHaveLength(1);
  });

  it('leaves both tiles of the pair as the objects they were', () => {
    const held = heldTiles(target.grid);

    expect(held).toHaveLength(MERGE_PAIR_TILES);

    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));
    expect(target.effects.apply()).toBe(1);

    expectHeldUndisturbed(target.grid, held);
    expect(occupants(target.grid)).toHaveLength(MERGE_PAIR_TILES + 1);
  });

  it('inserts a real tile whose coordinates agree with its slot', () => {
    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));
    expect(target.effects.apply()).toBe(1);

    const cell = target.effects.inserts()[0].cell;
    const sprouted = target.grid.cellContent(cell);

    expect(sprouted).toBeInstanceOf(Tile);
    expect(sprouted?.x).toBe(cell.x);
    expect(sprouted?.y).toBe(cell.y);
    expect(target.grid.cells[cell.x][cell.y]).toBe(sprouted);
    expectSerialisationRoundTrip(target.grid);
  });

  it('records no previous position on the sprouted tile', () => {
    // js/tile.js L6-L7 leaves a fresh tile with no previous position and no
    // merge parentage.
    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));
    expect(target.effects.apply()).toBe(1);

    const held = heldTiles(target.grid);

    expect(held).toHaveLength(MERGE_PAIR_TILES + 1);

    for (const entry of held) {
      expect(entry.tile.previousPosition).toBeNull();
      expect(entry.tile.mergedFrom).toBeNull();
    }
  });

  it('returns the payload it was given, as the object it arrived as', () => {
    const payload = spawnPayload(SPAWN_CELL, SPAWN_VALUE);
    const result = dispatchSpawn(target, payload);

    expect(result).not.toBeUndefined();
    expect(result).toBe(payload);
    expect(payload.position).toEqual(SPAWN_CELL);
    expect(payload.value).toBe(SPAWN_VALUE);
    expect(payload.count).toBeUndefined();
  });

  it('carries a raised spawn count through untouched', () => {
    const payload: SpawnPayload = {
      position: SPAWN_CELL,
      value: SPAWN_VALUE,
      count: 2,
    };
    const result = dispatchSpawn(target, payload);

    expect(result).toBe(payload);
    expect(payload.count).toBe(2);
    expect(target.effects.inserts()).toHaveLength(1);
  });

  it('sprouts the value the payload carried, a member of the ladder in ' +
    'force', () => {
    expect(target.config.spawn.values).toEqual([2, 4]);
    expect(Object.isFrozen(target.config)).toBe(false);

    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));

    const sprout = target.effects.inserts()[0];

    expect(sprout.value).toBe(SPAWN_VALUE);
    expect(target.config.spawn.values).toContain(sprout.value);
  });

  it('sprouts from a mutated ladder once the rules carry another one', () => {
    target.config.spawn.values = [8, 16];
    target.config.spawn.weights = [0.5, 0.5];

    dispatchSpawn(target, spawnPayload(SPAWN_CELL, 8));

    const sprout = target.effects.inserts()[0];

    expect(sprout.value).toBe(8);
    expect(target.config.spawn.values).toContain(sprout.value);
    expect([2, 4]).not.toContain(sprout.value);

    expect(target.effects.apply()).toBe(1);
    expect(occupants(target.grid).map((cell) => cell.value).sort(ascending))
      .toEqual([2, 2, 8]);
  });
});

describe('the fertile-ground boundaries', () => {
  it('sprouts nothing and takes no draw when the payload carries no cell',
    () => {
      const target = mergePairBench();
      const before = cursorsOf(target);
      const payload = spawnPayload(undefined, SPAWN_VALUE);

      expect(dispatchSpawn(target, payload)).toBe(payload);
      expect(target.effects.recorded()).toHaveLength(0);
      expect(occupants(target.grid)).toHaveLength(MERGE_PAIR_TILES);
      expectDraws(before, cursorsOf(target), 0);
    });

  it('sprouts nothing and takes no draw when no empty cell lies beside a ' +
    'tile', () => {
    const target = bench(gridOf(createEmptyBoard()));
    const before = cursorsOf(target);

    expect(occupants(target.grid)).toHaveLength(0);

    dispatchSpawn(target, spawnPayload({ x: 0, y: 0 }, SPAWN_VALUE));

    expect(target.effects.recorded()).toHaveLength(0);
    expect(occupants(target.grid)).toHaveLength(0);
    expectDraws(before, cursorsOf(target), 0);
  });

  it('sprouts nothing on a full board, leaving the lattice and every ' +
    'cursor as they were', () => {
    // js/grid.js L37-L43 carries no `else` branch, so a board with no empty
    // cell yields no cell, and `RngStream.pick` consumes no draw for an empty
    // list.
    const target = bench(gridOf(createNearLossBoard()));
    const before = cursorsOf(target);
    const snapshot = target.grid.serialize();
    const held = heldTiles(target.grid);
    const payload = spawnPayload({ x: 0, y: 0 }, SPAWN_VALUE);

    expect(held).toHaveLength(FULL_BOARD_TILES);
    expect(target.grid.cellsAvailable()).toBe(false);
    expect(countNulls(snapshot)).toBe(0);

    expect(dispatchWithoutThrowing(target, payload)).toBe(payload);

    const after = cursorsOf(target);

    expect(target.effects.recorded()).toHaveLength(0);
    expect(target.effects.queue.refused).toBe(0);
    expect(target.grid.serialize()).toEqual(snapshot);
    expect(after['spawn-position']).toBe(before['spawn-position']);
    expectDraws(before, after, 0);
    expectHeldUndisturbed(target.grid, held);
    expectCoherentLattice(target.grid);
  });

  it('adds exactly one tile when one cell is empty and the spawn claims it',
    () => {
      const target = bench(gridOf(createNearLossBoard()));
      const cell: Position = { x: 2, y: 2 };

      clearCell(target.grid, cell);

      expect(target.grid.availableCells()).toEqual([cell]);

      const before = cursorsOf(target);
      const held = heldTiles(target.grid);
      const snapshot = target.grid.serialize();

      expect(snapshot.size).toBe(DEFAULT_BOARD_SIZE);
      expect(snapshot.cells).toHaveLength(DEFAULT_BOARD_SIZE);
      expect(snapshot.cells[cell.x][cell.y]).toBeNull();
      expect(countNulls(snapshot)).toBe(1);

      dispatchSpawn(target, spawnPayload(cell, SPAWN_VALUE));

      expect(target.effects.recorded()).toHaveLength(0);
      expectDraws(before, cursorsOf(target), 0);
      expectHeldUndisturbed(target.grid, held);

      // js/game_manager.js L69-L76 inserts the spawn the engine resolved once
      // the dispatch has returned.
      place(target.grid, cell.x, cell.y, SPAWN_VALUE);

      expect(occupants(target.grid)).toHaveLength(held.length + 1);
      expect(target.grid.cellsAvailable()).toBe(false);
      expectCoherentLattice(target.grid);
      expectSerialisationRoundTrip(target.grid);
    });

  it('sprouts beyond a two-cell quadrant while the rules carry the full ' +
    'board', () => {
    const observed = new Set<string>();

    for (let index = 0; index < SWEEP_SIZE; index += 1) {
      observed.add(
        reducedBoardSprout(quadrantSeed(index), DEFAULT_BOARD_SIZE),
      );
    }

    for (const key of observed) {
      expect(FULL_BOARD_CANDIDATES).toContain(key);
    }

    expect(observed.size).toBeGreaterThan(REDUCED_BOARD_CANDIDATES.length);
    expect(
      [...observed].some((key) => !REDUCED_BOARD_CANDIDATES.includes(key)),
    ).toBe(true);
  });

  it('confines the sprout to the smaller board once the rules carry one',
    () => {
      const observed = new Set<string>();

      for (let index = 0; index < SWEEP_SIZE; index += 1) {
        observed.add(
          reducedBoardSprout(quadrantSeed(index), REDUCED_SIZE),
        );
      }

      expect([...observed].sort()).toEqual([...REDUCED_BOARD_CANDIDATES]);
    });
});

describe('the fertile-ground handler source', () => {
  it('records its insertion through the effect queue', () => {
    expect(handlerSource()).toMatch(/effects\s*\.\s*insertTile/u);
  });

  it('never writes the cell matrix directly', () => {
    expect(handlerSource()).not.toMatch(/cells\s*\[/u);
  });

  it('reads no clock, no document and no global random source', () => {
    const source = handlerSource();

    expect(source).not.toMatch(/Math\s*\.\s*random/u);
    expect(source).not.toMatch(/\bDate\b/u);
    expect(source).not.toMatch(/\bdocument\b/u);
    expect(source).not.toMatch(/\bwindow\b/u);
    expect(source).not.toMatch(/\blocalStorage\b/u);
  });

  it('carries no error handling and no reporting of its own', () => {
    const source = handlerSource();

    expect(source).not.toMatch(/\bcatch\b/u);
    expect(source).not.toMatch(/\bconsole\b/u);
  });
});

describe('fertile-ground and charges', () => {
  it('declares no charge budget and no state slot', () => {
    const declaration = relic();

    expect('charges' in declaration).toBe(false);
    expect('state' in declaration).toBe(false);
    expect(declaration.charges).toBeUndefined();
    expect(declaration.state).toBeUndefined();
  });

  it('never consults a budget and never asks for a charge to be spent', () => {
    const source = handlerSource();

    expect(source).not.toMatch(/\bcharges\b/u);
    expect(source).not.toMatch(/spendCharge/u);

    const target = mergePairBench();

    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));

    expect(target.chargeRequests).toEqual([]);
  });

  it('neither throws nor corrupts the board, the rules or the state slot ' +
    'when invoked with zero charges', () => {
    const target = mergePairBench({ charges: 0 });
    const held = heldTiles(target.grid);
    const payload = spawnPayload(SPAWN_CELL, SPAWN_VALUE);

    expect(target.context.charges).toBe(0);
    expect(dispatchWithoutThrowing(target, payload)).toBe(payload);
    expect(target.effects.apply()).toBe(1);

    expect(occupants(target.grid)).toHaveLength(MERGE_PAIR_TILES + 1);
    expectHeldUndisturbed(target.grid, held);
    expectCoherentLattice(target.grid);
    expectSerialisationRoundTrip(target.grid);
    expect(target.config).toEqual(createDefaultRulesConfig());
    expect(target.context.state).toBeUndefined();
    expect(target.chargeRequests).toEqual([]);
  });

  it('leaves a state slot it was handed exactly as it was', () => {
    const slot = { marker: 'untouched' };
    const target = mergePairBench({ charges: 0, state: slot });

    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));

    expect(target.context.state).toBe(slot);
    expect(target.context.state).toEqual({ marker: 'untouched' });
    expect(target.effects.inserts()).toHaveLength(1);
  });
});

describe('fertile-ground determinism', () => {
  it('advances the relic-draw cursor exactly once and no other cursor', () => {
    const target = mergePairBench();
    const before = cursorsOf(target);

    expect(before).toEqual({
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    });

    dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));

    const after = cursorsOf(target);

    expect(after['relic-draw']).toBe(1);
    expect(after['spawn-value']).toBe(0);
    expect(after['spawn-position']).toBe(0);
    expect(after['rarity-weight']).toBe(0);
    expectDraws(before, after, 1);
  });

  it('sprouts identically from two generators built from one seed', () => {
    const first = mergePairBench({ seed: SEED });
    const second = mergePairBench({ seed: SEED });

    for (const target of [first, second]) {
      dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));
      expect(target.effects.apply()).toBe(1);
    }

    expect(JSON.stringify(second.grid.serialize()))
      .toBe(JSON.stringify(first.grid.serialize()));
    expect(second.effects.inserts()).toEqual(first.effects.inserts());
    expect(cursorsOf(second)).toEqual(cursorsOf(first));
  });

  it('sprouts on every candidate cell across seeds', () => {
    const observed = new Set<string>();

    for (let index = 0; index < SWEEP_SIZE; index += 1) {
      const target = mergePairBench({ seed: `${SEED}-draw-${String(index)}` });

      dispatchSpawn(target, spawnPayload(SPAWN_CELL, SPAWN_VALUE));

      const recorded = target.effects.inserts();

      expect(recorded).toHaveLength(1);
      observed.add(cellKey(recorded[0].cell));
    }

    expect([...observed].sort()).toEqual([...MERGE_PAIR_CANDIDATES]);
  });
});

describe('the catalogue the suite read', () => {
  it('published a declaration this suite left exactly as it found it', () => {
    expect(FOUND_AS.hooks).toEqual(['onSpawn']);
    expect(FOUND_AS.members).toEqual(DECLARED_MEMBERS);
    expect(FOUND_AS.frozen).toBe(true);
    expect(FOUND_AS.hooksFrozen).toBe(true);
    expect(fingerprint(relic())).toEqual(FOUND_AS);
    expect(SPAWN_CONTROL_FAMILY.relics.map((entry) => entry.id))
      .toEqual(FAMILY_ORDER);
  });
});
