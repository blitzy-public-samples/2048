// The isolation suite for the `board-manipulation` relic `scouring-wind`, the
// line clear. Three properties, one section apiece: the hooks it fires on, the
// effect it produces, and the charge budget it carries.
//
// Five relics of the catalogue declare a charge budget — `frostbind` of
// `merge-magic`, and `temporal-anchor`, `tumbler`, `culling-blade` and
// `scouring-wind` of this family — and `scouring-wind`'s budget of one is the
// smallest of the five, so a single sweep exhausts it.
//
// THE AXIS. `scouring-wind` clears the line the family module defines as one
// fixed `x` across every `y`, which that module names both a column and a row.
// The COORDINATES are what settle it: one fixed `x` across every `y` is the
// OUTER index of the x-major store js/grid.js L88-L95 wrote through, so the
// cleared line is one contiguous sub-array of `cells`, where a visual row would
// instead be one element taken from each sub-array. `eachCell` walks the
// lattice x-outer and y-inner at js/grid.js L58-L64, and both walks report the
// same number of cells, so a count alone cannot tell one from the other. Every
// emptiness assertion below therefore names its coordinates, and every `it`
// title states the axis as the coordinates give it.
//
// Mechanical provenance the assertions rest on:
//   js/grid.js        L58-L64   `eachCell` walks x-outer, y-inner
//   js/grid.js        L80-L86   `cellContent` answers `null` off-lattice
//                               rather than raising, so an out-of-range read
//                               is a silent miss
//   js/grid.js        L89-L95   `insertTile` and `removeTile` index
//                               `cells[tile.x][tile.y]`; `removeTile` assigns
//                               `null`
//   js/grid.js        L102-L117 `serialize` keeps an empty cell as `null` in
//                               the `{ size, cells }` shape
//   js/game_manager.js L238-L240 the loss probe is
//                               `cellsAvailable() || tileMatchesAvailable()`,
//                               carried into `movesAvailable` in
//                               src/engine/terminal-state.ts
//   js/tile.js        L2-L3     a tile flattens its position onto `x` and `y`
//
// Traceability rows this suite evidences, per docs/TRACEABILITY_MATRIX.md:
//   TR-BOARD-04 `scouring-wind` on `onAfterMove`, and the four `js/grid.js`
//   anchors above together with js/game_manager.js L238-L268.
//
// Named figures, per docs/architecture/: Figure 5, "Hook Dispatch Sequence:
// Pickup-Order Fan-Out with Charge Guard and Error Isolation"
// (docs/architecture/hook-dispatch-sequence.md), carries the charge-guard path
// this suite's budget section exercises; Figure 4, "Turn Data Flow"
// (docs/architecture/data-flow.md), carries the `Moves available?` decision
// node the terminal-board case exercises.
//
// Decisions behind the unit under test are argued in docs/DECISION_LOG.md and
// named here only so they can be found from the log: DL-BOARD-01, the budget a
// handler asks for through `HookContext.spendCharge` without reading it, and
// DL-BOARD-02, the effect carried by a `context.effects` command the engine
// applies.
//
// HOW THE EFFECT IS OBSERVED. A handler never holds the live `Grid`: it reads a
// `ReadonlyGridView` and RECORDS `removeTile` commands on
// `HookContext.effects`, which src/engine/hook-bus.ts applies through
// `Grid.removeTile` once the handler has returned and its return has
// validated. Every board assertion here therefore runs a real dispatch through
// a real bus against a real lattice. The bus's own skip, ordering and
// containment mechanisms are asserted by the suites under tests/unit/engine/
// and are not re-proved here.
//
// Rule 3: every context carries the run correlation identifier, and every bus
// is built with the injected `NOOP_ENGINE_REPORTER`. Nothing here reads a
// document, a clock, a network or `console`, so the suite runs under the `test`
// script in the DOM-free vitest project.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import {
  createHookBus,
  createReadonlyGridView,
} from '../../../src/engine/hook-bus';
import type {
  HookBus,
  HookDispatchResult,
} from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  AfterMoveDispatchPayload,
  AfterMovePayload,
  HookContext,
  HookEnvironment,
  HookHandler,
  HookName,
} from '../../../src/engine/hooks';
import { movesAvailable } from '../../../src/engine/terminal-state';
import { Tile } from '../../../src/engine/tile';
import { NOOP_ENGINE_REPORTER } from '../../../src/engine/types';
import type {
  Position,
  SerializedGameState,
} from '../../../src/engine/types';
import {
  BOARD_MANIPULATION_FAMILY,
} from '../../../src/relics/families/board-manipulation';
import {
  RelicRegistry,
  findRelicById,
} from '../../../src/relics/relic-registry';
import { RARITIES } from '../../../src/relics/relic-types';
import type { Relic } from '../../../src/relics/relic-types';
import { createRngStreams } from '../../../src/rng/rng-streams';
import type { RngStreams } from '../../../src/rng/rng-streams';
import {
  createBlockedBoard,
  createEmptyBoard,
  createMergePairBoard,
  createNearLossBoard,
} from '../../fixtures/boards';

/* ==========================================================================
 * 1. Harness
 * ========================================================================== */

/** Identifier of the relic under test. */
const RELIC_ID = 'scouring-wind';

/** Its position in `BOARD_MANIPULATION_FAMILY.relics`. */
const FAMILY_POSITION = 3;

/** Relics the family declares. */
const FAMILY_SIZE = 4;

/** The budget the declaration carries. */
const DECLARED_CHARGES = 1;

/** Registered as a budget: `undefined` is an unlimited registration. */
const UNLIMITED: undefined = undefined;

/** Run correlation identifier every context and every report carries. */
const CORRELATION_ID = 'run-scouring-wind-suite';

/** Fixed seed every substream table below is derived from. */
const SEED = 'scouring-wind-suite-seed';

/** A second fixed seed, used to show the sweep ignores randomness. */
const ALTERNATE_SEED = 'scouring-wind-suite-other-seed';

/** Identifier of the subscriber that hands the handler a live context. */
const PROBE_ID = 'scouring-wind-probe';

/**
 * Face value placed at (0, 0) to leave a full board with no mergeable pair.
 *
 * The near-loss fixture cycles the values 2, 4, 8, 16 and 32, so this value
 * matches no neighbour at any board size. Each use asserts that.
 */
const ISOLATING_VALUE = 4096;

/** The cell the terminal-board builder re-values. */
const ORIGIN: Position = Object.freeze({ x: 0, y: 0 });

/** The five hook names `scouring-wind` does not bind. */
const UNBOUND_HOOKS: readonly HookName[] = Object.freeze(
  HOOK_NAMES.filter((name): boolean => name !== 'onAfterMove'),
);

/** Every member `Relic` declares, sorted, as `scouring-wind` carries them. */
const DECLARED_MEMBERS: readonly string[] = Object.freeze([
  'charges',
  'description',
  'hooks',
  'id',
  'name',
  'rarity',
  'state',
]);

/**
 * The declaration reduced to comparable data, hook names included.
 *
 * Read without `expect`, so it can be taken at module scope before any test
 * runs and compared against again once every test has.
 *
 * @returns The declaration's data members as one string.
 */
function declarationSnapshot(): string {
  const found = findRelicById(RELIC_ID);

  return JSON.stringify({
    id: found?.id,
    name: found?.name,
    rarity: found?.rarity,
    description: found?.description,
    charges: found?.charges,
    state: found?.state ?? null,
    hooks: Object.keys(found?.hooks ?? {}),
  });
}

/** The declaration as it stood before this file dispatched anything. */
const SHIPPED_DECLARATION = declarationSnapshot();

/**
 * Resolves the relic out of the real catalogue.
 *
 * @returns The declaration. Fails the case where the catalogue carries no such
 *   identifier, so a rename fails loudly rather than silently skipping.
 */
function relicUnderTest(): Relic {
  const found = findRelicById(RELIC_ID);

  expect(found, `${RELIC_ID} is in the relic catalogue`).toBeDefined();

  return found as Relic;
}

/**
 * Resolves the handler bound to `onAfterMove`.
 *
 * @returns The bound handler.
 */
function boundHandler(): HookHandler<'onAfterMove'> {
  const bound = relicUnderTest().hooks.onAfterMove;

  expect(bound, `${RELIC_ID} binds onAfterMove`).toBeTypeOf('function');

  return bound as HookHandler<'onAfterMove'>;
}

/**
 * A handler's source with every comment removed.
 *
 * Line and block comments are stripped, so an absence check below matches
 * against the code a handler runs and not against the prose around it.
 *
 * @param handler Handler to read.
 * @returns The handler's source, comments replaced by single spaces.
 */
function handlerCode(handler: HookHandler<'onAfterMove'>): string {
  return String(handler)
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\/\/[^\n]*/gu, ' ');
}

/** The collaborators one dispatch needs, built fresh per test. */
interface Rig {
  readonly grid: Grid;
  readonly config: RulesConfig;
  readonly streams: RngStreams;
  readonly bus: HookBus;
  readonly environment: HookEnvironment;
}

/**
 * Builds a live grid from a fixture board.
 *
 * `Grid.fromState` reads `state[x][y]`, so the CELL MATRIX is what a grid is
 * restored from, not the whole `{ size, cells }` record.
 *
 * @param board Fixture board, freshly built and unfrozen.
 * @returns A live grid holding that board's tiles.
 */
function gridOf(board: SerializedGameState): Grid {
  return new Grid(board.grid.size, board.grid.cells);
}

/**
 * Builds a rig around one board, with nothing registered on its bus.
 *
 * The rules are a fresh `createDefaultRulesConfig()` per call — never the
 * deep-frozen `DEFAULT_RULES_CONFIG` — with `boardSize` reconciled to the
 * board's own edge length.
 *
 * @param grid Board the dispatch resolves against.
 * @param seed Run seed the substreams are derived from.
 * @returns The rig.
 */
function harnessOn(grid: Grid, seed: string = SEED): Rig {
  const config = createDefaultRulesConfig();

  config.boardSize = grid.size;

  const streams = createRngStreams(seed);
  const bus = createHookBus({
    correlationId: CORRELATION_ID,
    reporter: NOOP_ENGINE_REPORTER,
  });

  return {
    grid,
    config,
    streams,
    bus,
    environment: { config, rng: streams, grid },
  };
}

/**
 * Registers the catalogue relic on a rig's bus.
 *
 * @param rig Rig to register on.
 * @param charges Budget to register under. `UNLIMITED` registers a subscriber
 *   the bus never charge-guards.
 */
function hold(rig: Rig, charges: number | undefined): void {
  const definition = relicUnderTest();

  expect(
    rig.bus.register({
      id: definition.id,
      hooks: definition.hooks,
      charges,
      state: definition.state,
    }),
  ).toBe(true);
}

/**
 * Builds a rig with the relic already held under one budget.
 *
 * `charges` carries no default. `UNLIMITED` is one of the values this
 * parameter accepts, and a default would resolve it to the declared budget.
 *
 * @param grid Board the dispatch resolves against.
 * @param charges Budget to register under.
 * @param seed Run seed the substreams are derived from.
 * @returns The rig.
 */
function holding(
  grid: Grid,
  charges: number | undefined,
  seed: string = SEED,
): Rig {
  const rig = harnessOn(grid, seed);

  hold(rig, charges);

  return rig;
}

/**
 * The `onAfterMove` payload as the ENGINE hands it to the bus: the live board,
 * which the bus replaces with a frozen view before the first handler runs.
 *
 * @param grid Live board.
 * @param score Score the move settled at.
 * @returns The dispatch-input payload.
 */
function dispatchPayload(
  grid: Grid,
  score: number,
): AfterMoveDispatchPayload {
  return {
    moved: true,
    board: grid,
    score,
    over: false,
    won: false,
    terminated: false,
  };
}

/**
 * The `onAfterMove` payload as a HANDLER receives it, built here so a direct
 * invocation controls the score and the three flags it carries.
 *
 * @param grid Live board the frozen view is opened over.
 * @param score Score the move settled at.
 * @returns The handler-facing payload.
 */
function handlerPayload(grid: Grid, score: number): AfterMovePayload {
  return {
    moved: true,
    board: createReadonlyGridView(grid),
    score,
    over: false,
    won: false,
    terminated: false,
  };
}

/**
 * Dispatches `onAfterMove` on a rig.
 *
 * @param rig Rig to dispatch on.
 * @param score Score the move settled at.
 * @returns The dispatch's resolved payload and counts.
 */
function sweep(rig: Rig, score = 0): HookDispatchResult<'onAfterMove'> {
  return rig.bus.dispatch(
    'onAfterMove',
    dispatchPayload(rig.grid, score),
    rig.environment,
  );
}

/** What one direct invocation of the handler reported. */
interface DirectCall {
  /** What the handler returned, or `undefined` where it returned nothing. */
  readonly returned: AfterMovePayload | void;

  /** The state slot the handler wrote, read off the context it was given. */
  readonly state: unknown;

  /** What the handler threw, and `undefined` where it threw nothing. */
  readonly threw: unknown;

  /** The budget the context the handler read actually reported. */
  readonly observedCharges: number | undefined;

  /** The run correlation identifier that context carried. */
  readonly observedCorrelationId: string;

  /** The surrounding dispatch's own counts. */
  readonly result: HookDispatchResult<'onAfterMove'>;
}

/**
 * Invokes the handler inside a live dispatch, under a NOTIONAL budget.
 *
 * A probe subscriber is what opens a real transaction — the live effect
 * queue, the live randomness fork and a live state copy — so the handler is
 * called with the collaborators a dispatch actually hands it. `charges` on
 * the context it reads is the value named here, which is how a zero and a
 * negative budget are put in front of a handler the bus would otherwise have
 * skipped. The bus's own skip is asserted under tests/unit/engine/ and is not
 * re-proved here.
 *
 * @param rig Rig to dispatch on. Its bus must hold no other subscriber.
 * @param charges Budget the context reports.
 * @param score Score the payload carries.
 * @returns What the invocation returned, wrote and threw.
 */
function invokeDirectly(
  rig: Rig,
  charges: number | undefined,
  score = 0,
): DirectCall {
  const handler = boundHandler();
  let returned: AfterMovePayload | void = undefined;
  let state: unknown;
  let threw: unknown;
  let observedCharges: number | undefined;
  let observedCorrelationId = '';

  expect(
    rig.bus.register({
      id: PROBE_ID,
      hooks: {
        onAfterMove: (payload, context): AfterMovePayload => {
          const notional: HookContext = { ...context, charges };

          // The bus contains a throw raised inside a handler, so an
          // assertion made here would go unreported; both values are recorded
          // and asserted after the dispatch returns.
          observedCharges = notional.charges;
          observedCorrelationId = notional.correlationId;

          try {
            returned = handler(handlerPayload(rig.grid, score), notional);
          } catch (error: unknown) {
            threw = error;
          }

          state = notional.state;

          return payload;
        },
      },
    }),
  ).toBe(true);

  const result = sweep(rig, score);

  // The probe itself returned normally, so a contained failure here would be
  // this harness rather than the unit under test, whose throw `threw` records.
  expect(result.invoked).toBe(1);
  expect(result.failed).toBe(0);
  expect(result.rejected).toBe(0);
  expect(observedCharges).toBe(charges);

  return {
    returned,
    state,
    threw,
    observedCharges,
    observedCorrelationId,
    result,
  };
}

/** The state slot `scouring-wind` records, as this suite reads it back. */
interface ScourRecord {
  readonly scours: number;
  readonly column: { readonly x: number; readonly values: number[] } | null;
}

/**
 * Reads one subscriber's committed state slot in the relic's own shape.
 *
 * @param rig Rig whose bus holds the subscriber.
 * @param id Subscriber identifier.
 * @returns The slot, asserted to carry a finite sweep count.
 */
function recordedState(rig: Rig, id: string = RELIC_ID): ScourRecord {
  const slot = rig.bus
    .subscriptions('onAfterMove')
    .find((subscription): boolean => subscription.subscriberId === id)?.state;

  expect(slot).toBeTypeOf('object');
  expect(slot).not.toBeNull();
  expect((slot as ScourRecord).scours).toBeTypeOf('number');

  return slot as ScourRecord;
}

/**
 * The column a slot records, asserted to be present.
 *
 * @param record Slot to read.
 * @returns The recorded column.
 */
function sweptColumn(record: ScourRecord): NonNullable<ScourRecord['column']> {
  expect(record.column).not.toBeNull();

  return record.column as NonNullable<ScourRecord['column']>;
}

/** One occupied cell, as this suite compares them. */
interface Occupant {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * The occupied cells of a board, x-outer and y-inner.
 *
 * @param grid Board to read.
 * @returns One record per occupied cell, in `eachCell` order.
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
 * The cells of one column, in ascending `y`.
 *
 * @param size Edge length of the board.
 * @param x Column index.
 * @returns Every cell of that column.
 */
function columnCells(size: number, x: number): Position[] {
  const cells: Position[] = [];

  for (let y = 0; y < size; y += 1) {
    cells.push({ x, y });
  }

  return cells;
}

/**
 * Every cell that is NOT in one column, x-outer and y-inner.
 *
 * @param size Edge length of the board.
 * @param x Column index to exclude.
 * @returns Every other cell.
 */
function cellsOffColumn(size: number, x: number): Position[] {
  const cells: Position[] = [];

  for (let column = 0; column < size; column += 1) {
    if (column === x) {
      continue;
    }

    for (let y = 0; y < size; y += 1) {
      cells.push({ x: column, y });
    }
  }

  return cells;
}

/**
 * The sorted face values a cell list holds.
 *
 * @param grid Board to read.
 * @param cells Cells to read.
 * @returns The values found, ascending, empty cells contributing nothing.
 */
function valuesAt(grid: Grid, cells: readonly Position[]): number[] {
  const found: number[] = [];

  for (const cell of cells) {
    const tile = grid.cellContent(cell);

    if (tile !== null) {
      found.push(tile.value);
    }
  }

  return found.sort((left, right): number => left - right);
}

/**
 * Asserts a board is internally consistent.
 *
 * Five checks: the matrix is square; every slot holds a `Tile` or `null`; every
 * occupant's own `x` and `y` match the slot it sits in, which is the pairing
 * js/grid.js L89-L95 wrote and js/tile.js L2-L3 flattened; no tile occupies two
 * slots; a read outside the lattice answers `null` as js/grid.js L80-L86 did;
 * the snapshot js/grid.js L102-L117 writes round-trips through `Grid`; and no
 * surviving tile carries a `mergedFrom` pair standing on an emptied cell.
 *
 * @param grid Board to check.
 */
function expectCoherentLattice(grid: Grid): void {
  const seen = new Set<Tile>();

  expect(grid.cells).toHaveLength(grid.size);

  for (let x = 0; x < grid.size; x += 1) {
    const column = grid.cells[x];

    expect(column).toHaveLength(grid.size);

    for (let y = 0; y < grid.size; y += 1) {
      const slot = column[y];

      expect(slot === null || slot instanceof Tile).toBe(true);

      if (slot === null) {
        continue;
      }

      expect({ x: slot.x, y: slot.y }).toEqual({ x, y });
      expect(seen.has(slot)).toBe(false);

      seen.add(slot);

      for (const source of slot.mergedFrom ?? []) {
        expect(grid.cellOccupied({ x: source.x, y: source.y })).toBe(true);
      }
    }
  }

  expect(seen.size).toBe(occupants(grid).length);
  expect(grid.cellContent({ x: grid.size, y: 0 })).toBeNull();
  expect(grid.cellContent({ x: 0, y: grid.size })).toBeNull();
  expect(grid.cellContent({ x: -1, y: 0 })).toBeNull();

  const snapshot = grid.serialize();

  expect(new Grid(snapshot.size, snapshot.cells).serialize()).toEqual(snapshot);
}

/**
 * Places one tile through the lattice's own insertion path.
 *
 * @param grid Board to write.
 * @param cell Cell to occupy.
 * @param value Face value the tile carries.
 * @returns The inserted tile.
 */
function place(grid: Grid, cell: Position, value: number): Tile {
  const tile = new Tile(cell, value);

  grid.insertTile(tile);

  return tile;
}

/**
 * Clears one cell through the lattice's own removal path.
 *
 * @param grid Board to write.
 * @param cell Cell to clear. Must be occupied.
 */
function clearCell(grid: Grid, cell: Position): void {
  const standing = grid.cellContent(cell);

  expect(standing).not.toBeNull();

  grid.removeTile(standing as Tile);
}

/**
 * Places a tile that records the two tiles a merge produced it from, both
 * standing on its own cell — the pairing js/game_manager.js L156-L170 left
 * behind, with `mergedFrom` written as js/tile.js L7 declares it.
 *
 * @param grid Board to write.
 * @param cell Cell the merged tile occupies.
 * @param value Face value the merge yielded.
 * @returns The merged tile.
 */
function placeMerged(grid: Grid, cell: Position, value: number): Tile {
  const merged = place(grid, cell, value);

  merged.mergedFrom = [
    new Tile(cell, value / 2),
    new Tile(cell, value / 2),
  ];

  return merged;
}

/**
 * The near-loss fixture with (0, 0) re-valued so no two orthogonal neighbours
 * match, which leaves a full board `movesAvailable` reports as terminal.
 *
 * @param size Edge length in cells.
 * @returns The live board.
 */
function terminalBoard(size: number): Grid {
  const grid = gridOf(createNearLossBoard(size));

  clearCell(grid, ORIGIN);
  place(grid, ORIGIN, ISOLATING_VALUE);

  // Asserted rather than assumed: the replacement matches neither orthogonal
  // neighbour, which is what leaves the board with no mergeable pair at all.
  expect(grid.cellContent({ x: 1, y: 0 })?.value).not.toBe(ISOLATING_VALUE);
  expect(grid.cellContent({ x: 0, y: 1 })?.value).not.toBe(ISOLATING_VALUE);

  return grid;
}

/**
 * A board whose column 0 is one cell short of full and whose column 1 is full,
 * with every other cell empty.
 *
 * @param size Edge length in cells.
 * @returns The live board.
 */
function partialThenFullBoard(size: number): Grid {
  const grid = new Grid(size);

  for (let y = 0; y < size - 1; y += 1) {
    place(grid, { x: 0, y }, 2);
  }

  for (let y = 0; y < size; y += 1) {
    place(grid, { x: 1, y }, 4);
  }

  return grid;
}

/** The rig most cases below dispatch on: the blocked fixture, one charge. */
let baseline: Rig;

beforeEach((): void => {
  // A fresh `createDefaultRulesConfig()`, a fresh substream table, a fresh bus
  // and a fresh state slot per test. The blocked fixture holds exactly one
  // fully-occupied column, at x = 0, with every other cell empty.
  baseline = holding(gridOf(createBlockedBoard()), DECLARED_CHARGES);
});

/* ==========================================================================
 * 2. Property one: it fires on onAfterMove and on no other hook
 * ========================================================================== */

describe('scouring-wind is declared as the fourth board-manipulation relic',
  () => {
    it('is the entry at position 3 of the family, and the same object the '
      + 'catalogue resolves by id', () => {
      const family = BOARD_MANIPULATION_FAMILY;

      expect(family.name).toBe('board-manipulation');
      expect(family.relics).toHaveLength(FAMILY_SIZE);
      expect(family.relics[FAMILY_POSITION]?.id).toBe(RELIC_ID);

      // One object, not two copies: the catalogue freezes the family's own
      // declarations in place rather than adopting copies of them.
      expect(findRelicById(RELIC_ID)).toBe(family.relics[FAMILY_POSITION]);
    });

    it('declares the Scouring Wind name, the legendary rarity and a '
      + 'description that states the axis as one x across every y', () => {
      const relic = relicUnderTest();

      expect(relic.name).toBe('Scouring Wind');
      expect(relic.rarity).toBe(RARITIES[FAMILY_POSITION]);
      expect(relic.rarity).toBe('legendary');
      expect(typeof relic.description).toBe('string');
      expect(relic.description.length).toBeGreaterThan(0);

      // The player-facing copy names the same axis the handler acts on.
      expect(relic.description).toContain('column');
      expect(relic.description).toContain('single x across every y');
    });

    it('carries the seven members Relic declares and no others', () => {
      expect(Object.keys(relicUnderTest()).sort()).toEqual(DECLARED_MEMBERS);
    });
  });

describe('scouring-wind binds onAfterMove alone', () => {
  it('binds exactly one hook name, and it is a member of HOOK_NAMES', () => {
    const bound = Object.keys(relicUnderTest().hooks);

    expect(bound).toEqual(['onAfterMove']);

    for (const name of bound) {
      expect(HOOK_NAMES).toContain(name);
    }
  });

  it('leaves the other five hook names absent, not present as undefined',
    () => {
      const hooks = relicUnderTest().hooks;

      expect(UNBOUND_HOOKS).toHaveLength(HOOK_NAMES.length - 1);

      for (const name of UNBOUND_HOOKS) {
        expect(name in hooks).toBe(false);
        expect(Object.prototype.hasOwnProperty.call(hooks, name)).toBe(false);
      }
    });

  it('binds a callable that takes a payload and a context', () => {
    const handler = relicUnderTest().hooks.onAfterMove;

    expect(handler).toBeTypeOf('function');
    expect(handler?.length).toBe(2);
  });

  it('is subscribed to onAfterMove and to no other hook on one bus', () => {
    const rig = holding(gridOf(createBlockedBoard()), DECLARED_CHARGES);

    expect(rig.bus.subscriptions('onAfterMove')).toHaveLength(1);

    for (const name of UNBOUND_HOOKS) {
      expect(rig.bus.subscriptions(name)).toHaveLength(0);
    }
  });

  it('keeps no module-level state: two sweeps on one slot count two, and a '
    + 'fresh slot counts one', () => {
    // An unlimited registration is never charge-guarded, so the same
    // subscriber can sweep twice within one run.
    const twice = holding(new Grid(DEFAULT_BOARD_SIZE), UNLIMITED);

    for (let y = 0; y < twice.grid.size; y += 1) {
      place(twice.grid, { x: 0, y }, 2);
    }

    sweep(twice);

    for (let y = 0; y < twice.grid.size; y += 1) {
      place(twice.grid, { x: 0, y }, 2);
    }

    sweep(twice);

    expect(recordedState(twice)).toEqual({
      scours: 2,
      column: { x: 0, values: [2, 2, 2, 2] },
    });

    const once = holding(gridOf(createBlockedBoard()), UNLIMITED);

    sweep(once);

    expect(recordedState(once)).toEqual({
      scours: 1,
      column: { x: 0, values: [2, 4, 8, 16] },
    });
  });

  it('records one sweep per slot when two runs sweep the same board', () => {
    const first = holding(gridOf(createBlockedBoard()), DECLARED_CHARGES);
    const second = holding(gridOf(createBlockedBoard()), DECLARED_CHARGES);

    sweep(first);
    sweep(second);

    expect(second.grid.serialize()).toEqual(first.grid.serialize());
    expect(recordedState(second)).toEqual(recordedState(first));
  });
});

/* ==========================================================================
 * 3. Property two: the effect is one whole column emptied, and nothing else
 * ========================================================================== */

describe('the sweep empties every tile at the selected x across all y', () => {
  it('leaves every cell of the swept column empty, cell by named cell', () => {
    sweep(baseline);

    const swept = columnCells(baseline.grid.size, 0);

    for (const cell of swept) {
      expect(baseline.grid.cellAvailable(cell)).toBe(true);
      expect(baseline.grid.cellOccupied(cell)).toBe(false);
      expect(baseline.grid.cellContent(cell)).toBeNull();
    }

    // js/grid.js L45-L55 collects the empty cells; every swept cell is now one.
    expect(baseline.grid.availableCells()).toEqual(
      expect.arrayContaining(swept),
    );

    // js/grid.js L102-L117 keeps an empty cell as `null` in the snapshot.
    expect(baseline.grid.serialize().cells[0]).toEqual([
      null,
      null,
      null,
      null,
    ]);

    expectCoherentLattice(baseline.grid);
  });

  it('records one removal per occupied cell of the column, in ascending y',
    () => {
      const result = sweep(baseline);

      expect(result.invoked).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.rejected).toBe(0);
      expect(result.effectsRefused).toBe(0);
      expect(result.effectsApplied).toBe(baseline.grid.size);
      expect(result.effects).toEqual([
        { kind: 'removeTile', cell: { x: 0, y: 0 } },
        { kind: 'removeTile', cell: { x: 0, y: 1 } },
        { kind: 'removeTile', cell: { x: 0, y: 2 } },
        { kind: 'removeTile', cell: { x: 0, y: 3 } },
      ]);
    });

  it('clears a column and not a row: on a full board every cell of x = 0 is '
    + 'empty while every cell of every other x still stands', () => {
    const rig = holding(gridOf(createNearLossBoard()), DECLARED_CHARGES);
    const size = rig.grid.size;

    sweep(rig);

    // THE AXIS ASSERTION. A cleared visual row would have emptied (x, 0) for
    // every x and left (0, 1) standing; a cleared column empties (0, y) for
    // every y and leaves (x, 0) standing for every other x. Both remove the
    // same NUMBER of tiles, so only these coordinates separate them.
    for (let y = 0; y < size; y += 1) {
      expect(rig.grid.cellContent({ x: 0, y })).toBeNull();
    }

    for (let x = 1; x < size; x += 1) {
      for (let y = 0; y < size; y += 1) {
        expect(rig.grid.cellContent({ x, y })).not.toBeNull();
      }
    }

    expectCoherentLattice(rig.grid);
  });

  it('leaves every tile off the swept column as the same object, at its own '
    + 'cell, with its own value', () => {
    const rig = holding(gridOf(createNearLossBoard()), DECLARED_CHARGES);
    const offColumn = cellsOffColumn(rig.grid.size, 0);
    const standing = new Map<string, Tile>();

    for (const cell of offColumn) {
      const tile = rig.grid.cellContent(cell);

      expect(tile).not.toBeNull();
      standing.set(`${String(cell.x)},${String(cell.y)}`, tile as Tile);
    }

    const before = valuesAt(rig.grid, offColumn);

    sweep(rig);

    for (const cell of offColumn) {
      const key = `${String(cell.x)},${String(cell.y)}`;
      const held = standing.get(key);

      // Identity, not equality: a survivor that was removed and re-inserted
      // would compare equal while being a different object.
      expect(rig.grid.cellContent(cell)).toBe(held);
      expect({ x: held?.x, y: held?.y }).toEqual({ x: cell.x, y: cell.y });
    }

    // The multiset an off-by-one would change: clearing the wrong column, or
    // one cell too many, moves a value out of this comparison.
    expect(valuesAt(rig.grid, offColumn)).toEqual(before);
  });

  it('drops the occupied-cell count by exactly the length of the column it '
    + 'swept, computed from the board it swept', () => {
    const rig = holding(gridOf(createNearLossBoard()), DECLARED_CHARGES);
    const before = occupants(rig.grid).length;
    const expectedDrop = valuesAt(rig.grid, columnCells(rig.grid.size, 0))
      .length;

    sweep(rig);

    expect(occupants(rig.grid)).toHaveLength(before - expectedDrop);
    expect(expectedDrop).toBe(rig.grid.size);
  });

  it('selects the first fully-occupied column in ascending x, leaving a '
    + 'partially occupied earlier column standing', () => {
    const rig = holding(partialThenFullBoard(DEFAULT_BOARD_SIZE),
      DECLARED_CHARGES);
    const size = rig.grid.size;

    sweep(rig);

    // Column 1 was the first FULL column, so it is the one that went.
    for (let y = 0; y < size; y += 1) {
      expect(rig.grid.cellContent({ x: 1, y })).toBeNull();
    }

    // Column 0 was one cell short of full and is untouched.
    for (let y = 0; y < size - 1; y += 1) {
      expect(rig.grid.cellContent({ x: 0, y })?.value).toBe(2);
    }

    expect(rig.grid.cellContent({ x: 0, y: size - 1 })).toBeNull();
    expect(occupants(rig.grid)).toHaveLength(size - 1);

    // Nothing was attempted against an empty cell: a removal aimed at one
    // would have been refused and counted rather than raising.
    expect(sweptColumn(recordedState(rig)).x).toBe(1);
    expectCoherentLattice(rig.grid);
  });

  it('refuses no removal, so no cell it aimed at was already empty', () => {
    const partial = holding(partialThenFullBoard(DEFAULT_BOARD_SIZE),
      DECLARED_CHARGES);
    const full = holding(gridOf(createNearLossBoard()), DECLARED_CHARGES);

    expect(sweep(partial).effectsRefused).toBe(0);
    expect(sweep(full).effectsRefused).toBe(0);
  });

  it('leaves a board whose every column is partially occupied entirely alone',
    () => {
      // The merge-pair fixture holds (0, 0) and (1, 0) alone, so no column of a
      // board wider than one row is full.
      const rig = holding(gridOf(createMergePairBoard()), DECLARED_CHARGES);
      const before = rig.grid.serialize();
      const result = sweep(rig);

      expect(rig.grid.serialize()).toEqual(before);
      expect(result.effectsApplied).toBe(0);
      expect(result.effects).toEqual([]);
      expect(result.effectsRefused).toBe(0);
      expect(result.chargesConsumed).toBe(0);

      // The slot is left exactly as the declaration shipped it, so a move that
      // swept nothing counts nothing.
      expect(recordedState(rig)).toEqual({ scours: 0, column: null });
      expectCoherentLattice(rig.grid);
    });

  it('fabricates no tile on the empty fixture and records no removal', () => {
    const rig = holding(gridOf(createEmptyBoard()), DECLARED_CHARGES);
    const before = rig.grid.serialize();

    expect((): void => {
      sweep(rig);
    }).not.toThrow();

    expect(rig.grid.serialize()).toEqual(before);
    expect(occupants(rig.grid)).toEqual([]);
    expect(rig.grid.availableCells()).toHaveLength(
      rig.grid.size * rig.grid.size,
    );
    expectCoherentLattice(rig.grid);
  });

  it('writes the lattice only through the removal command the engine applies',
    () => {
      const code = handlerCode(boundHandler());

      // js/grid.js L93-L95 is the removal path, reached as a recorded command.
      expect(code).toContain('removeTile(');
      expect(code).not.toMatch(/cells\s*\[/u);
      expect(code).not.toMatch(/\.cells\b/u);
      expect(code).not.toContain('insertTile');
      expect(code).not.toContain('savePosition');
      expect(code).not.toContain('updatePosition');

      const result = sweep(baseline);

      for (const effect of result.effects) {
        expect(effect.kind).toBe('removeTile');
      }

      expectCoherentLattice(baseline.grid);
    });

  it('keeps the score and the three flags the move resolved to', () => {
    const result = sweep(baseline, 12);

    expect(result.payload.score).toBe(12);
    expect(result.payload.over).toBe(false);
    expect(result.payload.won).toBe(false);
    expect(result.payload.terminated).toBe(false);
    expect(result.payload.moved).toBe(true);
  });

  it('returns a payload rather than nothing', () => {
    const call = invokeDirectly(
      harnessOn(gridOf(createBlockedBoard())),
      DECLARED_CHARGES,
      5,
    );

    expect(call.threw).toBeUndefined();
    expect(call.returned).toBeTypeOf('object');
    expect((call.returned as AfterMovePayload).score).toBe(5);
  });

  it('leaves the rules in force exactly as they stood', () => {
    const config = baseline.config;
    const canMerge = config.merge.canMerge;
    const produce = config.merge.produce;

    sweep(baseline);

    expect(config.boardSize).toBe(DEFAULT_BOARD_SIZE);
    expect(config.winValue).toBe(2048);
    expect(config.startTiles).toBe(2);
    expect(config.spawn.values).toEqual([2, 4]);
    expect(config.spawn.weights).toEqual([0.9, 0.1]);
    expect(config.merge.canMerge).toBe(canMerge);
    expect(config.merge.produce).toBe(produce);
  });

  it('leaves no surviving tile carrying a mergedFrom pair on an emptied cell',
    () => {
      const rig = holding(new Grid(DEFAULT_BOARD_SIZE), DECLARED_CHARGES);
      const size = rig.grid.size;

      // A merged tile INSIDE the column that goes, and one outside it: the
      // renderer draws both source tiles beneath a merged one, so a pair left
      // standing over an emptied cell would paint a phantom tile there.
      for (let y = 0; y < size; y += 1) {
        placeMerged(rig.grid, { x: 0, y }, 8);
      }

      const survivor = placeMerged(rig.grid, { x: 1, y: 0 }, 16);

      sweep(rig);

      expect(occupants(rig.grid)).toEqual([{ x: 1, y: 0, value: 16 }]);
      expect(rig.grid.cellContent({ x: 1, y: 0 })).toBe(survivor);
      expect(survivor.mergedFrom).not.toBeNull();

      for (const source of survivor.mergedFrom ?? []) {
        expect(rig.grid.cellOccupied({ x: source.x, y: source.y })).toBe(true);
      }

      expectCoherentLattice(rig.grid);
    });

  it('reports a column index inside 0 to size - 1, and every removal inside '
    + 'the lattice', () => {
    const rig = holding(gridOf(createNearLossBoard()), DECLARED_CHARGES);
    const result = sweep(rig);
    const column = sweptColumn(recordedState(rig));

    // js/grid.js L80-L86 answers `null` outside the lattice rather than
    // raising, so an out-of-range index would clear nothing and report nothing.
    expect(Number.isInteger(column.x)).toBe(true);
    expect(column.x).toBeGreaterThanOrEqual(0);
    expect(column.x).toBeLessThanOrEqual(rig.grid.size - 1);
    expect(column.values).toHaveLength(rig.grid.size);

    for (const effect of result.effects) {
      expect(effect.kind).toBe('removeTile');

      if (effect.kind !== 'removeTile') {
        continue;
      }

      expect(rig.grid.withinBounds(effect.cell)).toBe(true);
      expect(effect.cell.x).toBe(column.x);
      expect(effect.cell.y).toBeGreaterThanOrEqual(0);
      expect(effect.cell.y).toBeLessThanOrEqual(rig.grid.size - 1);
    }
  });

  it('leaves the near-loss fixture playable, with the emptied column now '
    + 'carrying the verdict on its own', () => {
    const rig = holding(gridOf(createNearLossBoard()), DECLARED_CHARGES);

    // js/game_manager.js L238-L240 is a two-part check. The fixture is full, so
    // its first half is false and its single adjacent equal pair — (0, 0) and
    // (1, 0) — is what the second half answers on.
    expect(rig.grid.cellsAvailable()).toBe(false);
    expect(movesAvailable(rig.grid, rig.config)).toBe(true);

    sweep(rig);

    // The pair's (0, 0) went with the column, and the first half now answers.
    expect(rig.grid.cellContent(ORIGIN)).toBeNull();
    expect(rig.grid.cellsAvailable()).toBe(true);
    expect(movesAvailable(rig.grid, rig.config)).toBe(true);
  });

  it('turns a terminal board back into a playable one, read through the '
    + 'exported movesAvailable', () => {
    const rig = holding(terminalBoard(DEFAULT_BOARD_SIZE), DECLARED_CHARGES);

    // js/game_manager.js L238-L240 is `cellsAvailable()` or
    // `tileMatchesAvailable()`. The board is full and holds no mergeable pair,
    // so both halves are false.
    expect(rig.grid.cellsAvailable()).toBe(false);
    expect(movesAvailable(rig.grid, rig.config)).toBe(false);

    sweep(rig);

    // Figure 4's `Moves available?` node, on the board the clear left behind.
    expect(rig.grid.cellsAvailable()).toBe(true);
    expect(movesAvailable(rig.grid, rig.config)).toBe(true);
    expect(rig.grid.availableCells()).toHaveLength(rig.grid.size);
    expectCoherentLattice(rig.grid);
  });
});

/* ==========================================================================
 * 4. The column length and the column bound come from the live board
 * ========================================================================== */

// A board-shrinking relic changes `boardSize` mid-run, so neither the length of
// the column nor the range the index is chosen from may be a captured 4.

for (const size of [3, 5]) {
  describe(`the sweep on a ${String(size)} by ${String(size)} board`, () => {
    it(`empties all ${String(size)} cells at the selected x, and only those`,
      () => {
        const rig = holding(gridOf(createNearLossBoard(size)),
          DECLARED_CHARGES);
        const offColumn = cellsOffColumn(size, 0);
        const before = valuesAt(rig.grid, offColumn);
        const result = sweep(rig);

        expect(rig.config.boardSize).toBe(size);
        expect(rig.grid.size).toBe(size);
        expect(result.effectsApplied).toBe(size);

        for (let y = 0; y < size; y += 1) {
          expect(rig.grid.cellContent({ x: 0, y })).toBeNull();
        }

        expect(valuesAt(rig.grid, offColumn)).toEqual(before);
        expect(occupants(rig.grid)).toHaveLength(size * size - size);
        expect(sweptColumn(recordedState(rig)).values).toHaveLength(size);
        expectCoherentLattice(rig.grid);
      });

    it(`clears the one full column of a ${String(size)}-wide blocked board`,
      () => {
        const rig = holding(gridOf(createBlockedBoard(size)),
          DECLARED_CHARGES);

        sweep(rig);

        expect(occupants(rig.grid)).toEqual([]);
        expect(rig.grid.availableCells()).toHaveLength(size * size);
        expectCoherentLattice(rig.grid);
      });

    it(`turns a terminal ${String(size)}-wide board back into a playable one`,
      () => {
        const rig = holding(terminalBoard(size), DECLARED_CHARGES);

        expect(movesAvailable(rig.grid, rig.config)).toBe(false);

        sweep(rig);

        expect(movesAvailable(rig.grid, rig.config)).toBe(true);
        expect(rig.grid.availableCells()).toHaveLength(size);
        expectCoherentLattice(rig.grid);
      });

    it(`reports a column index inside 0 to ${String(size - 1)}`, () => {
      const rig = holding(gridOf(createNearLossBoard(size)), DECLARED_CHARGES);

      sweep(rig);

      const column = sweptColumn(recordedState(rig));

      expect(column.x).toBeGreaterThanOrEqual(0);
      expect(column.x).toBeLessThanOrEqual(size - 1);
    });
  });
}

/* ==========================================================================
 * 5. Property three: the charge budget, including the zero-charge case
 * ========================================================================== */

describe('the declared charge budget', () => {
  it('is present on the declaration, finite, and above zero', () => {
    const charges = relicUnderTest().charges;

    expect(charges).toBeTypeOf('number');
    expect(Number.isFinite(charges)).toBe(true);
    expect(charges).toBeGreaterThan(0);
    expect(charges).toBe(DECLARED_CHARGES);
  });

  it('is never read, compared or written by the handler, which asks for a '
    + 'charge instead', () => {
    const code = handlerCode(boundHandler());

    // The guard and the decrement live in src/engine/hook-bus.ts, which is
    // Figure 5's charge-guard path; a handler asks and the bus decides.
    expect(code).not.toContain('charges');
    expect(code).toContain('spendCharge(');
  });

  it('spends exactly one charge on the sweep it performs', () => {
    const result = sweep(baseline);

    expect(result.chargesConsumed).toBe(DECLARED_CHARGES);
    expect(baseline.bus.subscriptions('onAfterMove')[0]?.charges).toBe(0);
  });

  it('spends nothing on a board with no fully-occupied column', () => {
    const rig = holding(gridOf(createEmptyBoard()), DECLARED_CHARGES);
    const result = sweep(rig);

    expect(result.chargesConsumed).toBe(0);
    expect(rig.bus.subscriptions('onAfterMove')[0]?.charges).toBe(
      DECLARED_CHARGES,
    );
  });
});

describe('an invocation made while the budget reads zero', () => {
  it('clears the column at the selected x without throwing', () => {
    const rig = harnessOn(gridOf(createBlockedBoard()));
    const call = invokeDirectly(rig, 0);

    expect(call.observedCharges).toBe(0);
    expect(call.threw).toBeUndefined();
    expect(call.returned).toBeTypeOf('object');
    expect(call.result.failed).toBe(0);

    for (let y = 0; y < rig.grid.size; y += 1) {
      expect(rig.grid.cellContent({ x: 0, y })).toBeNull();
    }
  });

  it('carries the run correlation identifier the bus was built with', () => {
    // Rule 3: the identifier is injected into the bus and reaches a handler on
    // its context, so the correlation plumbing is exercised end to end here.
    const call = invokeDirectly(harnessOn(gridOf(createBlockedBoard())), 0);

    expect(call.observedCorrelationId).toBe(CORRELATION_ID);
  });

  it('corrupts no run state: the board stays coherent, the rules stay as they '
    + 'were, and the slot keeps a valid shape', () => {
    const rig = harnessOn(gridOf(createNearLossBoard()));
    const canMerge = rig.config.merge.canMerge;
    const offColumn = cellsOffColumn(rig.grid.size, 0);
    const before = valuesAt(rig.grid, offColumn);
    const call = invokeDirectly(rig, 0);

    expect(call.threw).toBeUndefined();
    expectCoherentLattice(rig.grid);
    expect(valuesAt(rig.grid, offColumn)).toEqual(before);
    expect(rig.config.boardSize).toBe(DEFAULT_BOARD_SIZE);
    expect(rig.config.winValue).toBe(2048);
    expect(rig.config.spawn.values).toEqual([2, 4]);
    expect(rig.config.merge.canMerge).toBe(canMerge);
    expect(call.state).toEqual({
      scours: 1,
      column: { x: 0, values: [4, 8, 32, 4] },
    });
  });

  it('poisons nothing: an ordinary dispatch afterwards still sweeps and still '
    + 'pays its charge', () => {
    invokeDirectly(harnessOn(gridOf(createBlockedBoard())), 0);

    const later = holding(gridOf(createBlockedBoard()), DECLARED_CHARGES);
    const result = sweep(later);

    expect(result.chargesConsumed).toBe(DECLARED_CHARGES);
    expect(result.effectsApplied).toBe(later.grid.size);
    expect(occupants(later.grid)).toEqual([]);
    expect(recordedState(later)).toEqual({
      scours: 1,
      column: { x: 0, values: [2, 4, 8, 16] },
    });
  });

  it('behaves identically while the budget reads a negative number, which a '
    + 'restored run can carry', () => {
    // RelicRegistry.restore does not clamp a persisted budget, so a negative
    // count is reachable and must be as harmless as zero.
    const zeroRig = harnessOn(gridOf(createBlockedBoard()));
    const negativeRig = harnessOn(gridOf(createBlockedBoard()));
    const zeroCall = invokeDirectly(zeroRig, 0);
    const negativeCall = invokeDirectly(negativeRig, -3);

    expect(negativeCall.threw).toBeUndefined();
    expect(negativeCall.state).toEqual(zeroCall.state);
    expect(negativeRig.grid.serialize()).toEqual(zeroRig.grid.serialize());
    expectCoherentLattice(negativeRig.grid);
  });
});

describe('a run that exhausts the budget through the registry', () => {
  it('sweeps once, then leaves a rebuilt column standing without throwing',
    () => {
      const grid = gridOf(createBlockedBoard());
      const rig = harnessOn(grid);
      const registry = new RelicRegistry({
        bus: rig.bus,
        reporter: NOOP_ENGINE_REPORTER,
        correlationId: CORRELATION_ID,
      });

      expect(registry.pickUp(RELIC_ID)?.definition.id).toBe(RELIC_ID);
      expect(registry.find(RELIC_ID)?.charges).toBe(DECLARED_CHARGES);

      const first = sweep(rig);

      expect(first.effectsApplied).toBe(grid.size);
      expect(occupants(grid)).toEqual([]);
      expect(registry.find(RELIC_ID)?.charges).toBe(0);

      // The column is rebuilt, so the only thing standing between it and a
      // second clear is the spent budget.
      for (let y = 0; y < grid.size; y += 1) {
        place(grid, { x: 0, y }, 2);
      }

      const standing = occupants(grid).length;
      let second: HookDispatchResult<'onAfterMove'> | undefined;

      expect((): void => {
        second = sweep(rig);
      }).not.toThrow();

      expect(occupants(grid)).toHaveLength(standing);
      expect(second?.invoked).toBe(0);
      expect(second?.effectsApplied).toBe(0);
      expect(second?.chargesConsumed).toBe(0);
      expect(registry.find(RELIC_ID)?.charges).toBe(0);
      expectCoherentLattice(grid);
    });
});

/* ==========================================================================
 * 6. Determinism and substream hygiene
 * ========================================================================== */

/** Every substream standing at its starting position. */
const UNMOVED_CURSORS = Object.freeze({
  'spawn-value': 0,
  'spawn-position': 0,
  'relic-draw': 0,
  'rarity-weight': 0,
});

describe('the column the sweep selects is fixed by the board alone', () => {
  it('produces the same board and records the same column under two '
    + 'different seeds', () => {
    const first = holding(gridOf(createNearLossBoard()), DECLARED_CHARGES,
      SEED);
    const second = holding(gridOf(createNearLossBoard()), DECLARED_CHARGES,
      ALTERNATE_SEED);

    expect(first.streams.seed).not.toBe(second.streams.seed);

    sweep(first);
    sweep(second);

    expect(second.grid.serialize()).toEqual(first.grid.serialize());
    expect(recordedState(second)).toEqual(recordedState(first));
  });

  it('advances no substream cursor on the sweep it performs', () => {
    const before = baseline.streams.snapshotCursors();

    sweep(baseline);

    const after = baseline.streams.snapshotCursors();

    expect(after).toEqual(before);
    expect(after).toEqual(UNMOVED_CURSORS);

    // The two the reward draw owns, named separately: a board relic drawing
    // from either would shift every later relic offer.
    expect(after['relic-draw']).toBe(before['relic-draw']);
    expect(after['rarity-weight']).toBe(before['rarity-weight']);
  });

  it('advances no substream cursor on a board it leaves alone', () => {
    // `RngStream.pick` yields `undefined` on an empty candidate list without
    // advancing, so an empty board could not drift a cursor even through a
    // draw; this handler takes none at all.
    const rig = holding(gridOf(createEmptyBoard()), DECLARED_CHARGES);
    const before = rig.streams.snapshotCursors();

    sweep(rig);

    expect(rig.streams.snapshotCursors()).toEqual(before);
    expect(rig.streams.snapshotCursors()).toEqual(UNMOVED_CURSORS);
  });

  it('names no randomness source, no clock, no console and no catch of its '
    + 'own', () => {
    const code = handlerCode(boundHandler());

    expect(code).not.toContain('Math.random');
    expect(code).not.toContain('Date');
    expect(code).not.toContain('performance');
    expect(code).not.toContain('console');
    expect(code).not.toContain('catch');

    // Error containment belongs to src/engine/hook-bus.ts, which reports a
    // throw through its injected reporter; the family module owns none.
    expect(code).toContain('firstFullColumn(');
  });

  it('reaches no document, no storage and no timer', () => {
    const code = handlerCode(boundHandler());

    expect(code).not.toContain('document');
    expect(code).not.toContain('window');
    expect(code).not.toContain('localStorage');
    expect(code).not.toContain('setTimeout');
  });
});

/* ==========================================================================
 * 7. The catalogue declaration is left as it shipped
 * ========================================================================== */

describe('the catalogue declaration after every dispatch above', () => {
  it('is unchanged, still frozen, and still declares one charge', () => {
    const relic = relicUnderTest();

    // Live budgets belong to RelicRegistry and to the bus; the declaration is
    // shared by every run on the page and is never written by one.
    expect(declarationSnapshot()).toBe(SHIPPED_DECLARATION);
    expect(relic.charges).toBe(DECLARED_CHARGES);
    expect(relic.state).toEqual({ scours: 0, column: null });
    expect(Object.isFrozen(relic)).toBe(true);
    expect(Object.isFrozen(relic.hooks)).toBe(true);
    expect(Object.isFrozen(BOARD_MANIPULATION_FAMILY.relics)).toBe(true);
  });
});
