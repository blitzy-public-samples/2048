// The dedicated suite for the `board-manipulation` relic `culling-blade`, the
// excise relic, asserting the three properties AAP 0.6.3 Group 5 requires of
// every relic in isolation: that it fires only on the hooks it binds, that it
// produces its specified effect, and that it respects charges including the
// zero-charge case the prompt names outright.
//
// Provenance of the anchors this suite asserts against:
//   js/grid.js L58-L64    `eachCell` walks x-outer then y-inner, and
//                         `availableCells` at L45-L55 collects in that same
//                         order. That order is the tie-break the excision
//                         resolves equal face values by.
//   js/grid.js L93-L95    `removeTile` assigns `cells[tile.x][tile.y] = null`,
//                         which is the removal path the excision reaches
//                         through the board-effect queue.
//   js/grid.js L102-L117  `serialize` retains an empty cell as `null` inside
//                         the `{ size, cells }` shape, so a vacated cell is
//                         asserted as `null` rather than as absent.
//   js/game_manager.js L238-L240  the loss check is `cellsAvailable() ||
//                         tileMatchesAvailable()`, and L243-L268 is the
//                         neighbour probe. Both halves are reached here
//                         through the exported functions of
//                         src/engine/terminal-state.ts rather than restated.
//   js/tile.js L1-L17     a tile carries its own `x` and `y`, which is why a
//                         survivor is asserted by object identity as well as
//                         by position.
//
// Figures this suite exercises, named per Rule 2:
//   Figure 5, "Hook Dispatch Sequence: Pickup-Order Fan-Out with Charge Guard
//   and Error Isolation" (docs/architecture/hook-dispatch-sequence.md) is the
//   charge-guard path the charge cases below drive.
//   Figure 4, "Turn Data Flow" (docs/architecture/data-flow.md) carries the
//   `Moves available?` decision node the terminal-state cases below exercise.
//
// Decision-log pointers, argued in docs/DECISION_LOG.md and named here only so
// the constructs can be found from the log: DL-BOARD-01 for a charge budget
// declared by the relic and spent by the bus, DL-BOARD-02 for an effect
// carried by a recorded command rather than by a live board write.
//
// The suite reads no DOM, takes no unseeded randomness, reads no clock and
// starts no timer, and it runs in the `unit:dom-free` project.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { createHookBus } from '../../../src/engine/hook-bus';
import type {
  HookBus,
  HookDispatchResult,
} from '../../../src/engine/hook-bus';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  BeforeMovePayload,
  HookContext,
  HookDispatchPayloadMap,
  HookEnvironment,
  HookName,
} from '../../../src/engine/hooks';
import {
  movesAvailable,
  tileMatchesAvailable,
} from '../../../src/engine/terminal-state';
import { Tile } from '../../../src/engine/tile';
import {
  DIRECTION_LEFT,
  NOOP_ENGINE_REPORTER,
} from '../../../src/engine/types';
import type { SerializedGameState } from '../../../src/engine/types';
import {
  BOARD_MANIPULATION_FAMILY,
} from '../../../src/relics/families/board-manipulation';
import {
  RELIC_CATALOGUE,
  RelicRegistry,
  findRelicById,
} from '../../../src/relics/relic-registry';
import type { Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type { RngCursorMap, RngStreams } from '../../../src/rng/rng-streams';
import {
  createBlockedBoard,
  createEmptyBoard,
  createMergePairBoard,
  createNearLossBoard,
} from '../../fixtures/boards';

/* ==========================================================================
 * 1. Constants of the unit under test
 * ========================================================================== */

/** Catalogue identifier of the relic this suite covers. */
const RELIC_ID = 'culling-blade';

/** The one hook the relic binds. */
const BOUND_HOOK = 'onBeforeMove' satisfies HookName;

/** Charge budget the declaration ships. */
const DECLARED_CHARGES = 2;

/** Relics the catalogue declares across its four families. */
const CATALOGUE_RELICS = 16;

/** Relics of the board-manipulation family. */
const FAMILY_RELICS = 4;

/** Relics of the catalogue that declare a charge budget. */
const CHARGE_BEARING_RELICS = 5;

/** Tiles at the lowest spawn value that arm the blade. */
const ARMING_TILES = 6;

/** Share of the board the blade must have empty before it acts. */
const SCARCITY_FRACTION = 0.25;

/** Fixed seed every dispatch in this suite runs under. */
const SUITE_SEED = 'culling-blade-suite';

/** A second seed, sharing no character sequence with the first. */
const ALTERNATE_SEED = 'wholly-other-run-42';

/** Run correlation identifier every bus in this suite reports under. */
const SUITE_CORRELATION = 'run-culling-blade-suite';

/** Identifier of the probe subscriber the direct-invocation cases seat. */
const PROBE_ID = 'culling-blade-context-probe';

/** Edge lengths the board-size cases run at, alongside the default of 4. */
const SMALL_BOARD_SIZE = 3;
const LARGE_BOARD_SIZE = 5;

/* ==========================================================================
 * 2. Board composition
 * ========================================================================== */

/** One tile to place while composing a board. */
interface Placement {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * A board of `size` carrying exactly the given tiles.
 *
 * Built on `createEmptyBoard`, so the board vocabulary, the `{ size, cells }`
 * shape and the `null` empty cell all come from tests/fixtures/boards.ts.
 *
 * @param size Edge length in cells.
 * @param placements Tiles to occupy, in any order.
 * @returns A fresh, unfrozen board.
 */
function boardWith(
  size: number,
  placements: readonly Placement[],
): SerializedGameState {
  const board = createEmptyBoard(size);

  for (const spot of placements) {
    board.grid.cells[spot.x][spot.y] = {
      position: { x: spot.x, y: spot.y },
      value: spot.value,
    };
  }

  return board;
}

/**
 * `count` cells of one value, taken in the x-outer, y-inner scan order of
 * js/grid.js L58-L64.
 *
 * @param size Edge length the cells are taken from.
 * @param count How many cells to occupy.
 * @param value Face value each one carries.
 * @returns The placements, in scan order.
 */
function scanOrderPlacements(
  size: number,
  count: number,
  value: number,
): Placement[] {
  const spots: Placement[] = [];

  for (let x = 0; x < size && spots.length < count; x += 1) {
    for (let y = 0; y < size && spots.length < count; y += 1) {
      spots.push({ x, y, value });
    }
  }

  return spots;
}

/**
 * A board armed for the blade: `count` tiles at the lowest spawn value, laid
 * out in scan order, on an otherwise empty board.
 *
 * @param size Edge length in cells.
 * @param count Tiles to place. Defaults to the arming threshold.
 * @param value Face value each one carries. Defaults to the lowest default
 *   spawn value.
 * @returns A fresh, unfrozen board.
 */
function armedBoard(
  size: number,
  count: number = ARMING_TILES,
  value = 2,
): SerializedGameState {
  return boardWith(size, scanOrderPlacements(size, count, value));
}

/** Empty cells a board of `size` must have before the blade acts. */
function scarcityBand(size: number): number {
  return Math.ceil(size * size * SCARCITY_FRACTION);
}

/* ==========================================================================
 * 3. The bench
 * ========================================================================== */

/**
 * The collaborators one case drives the relic through: the rules in force, the
 * run's substreams, the live board, and the bus that mints a dispatch context
 * over all three.
 */
interface Bench {
  readonly grid: Grid;
  readonly config: RulesConfig;
  readonly streams: RngStreams;
  readonly bus: HookBus;
  readonly environment: HookEnvironment;
}

/** How one bench is assembled. */
interface BenchOptions {
  /** Seed the substreams are derived from. Defaults to `SUITE_SEED`. */
  readonly seed?: string;

  /**
   * Charge budget to register the relic with, overriding the declaration's.
   */
  readonly charges?: number;

  /** Whether to seat the relic at all. Defaults to `true`. */
  readonly seatRelic?: boolean;
}

/**
 * Resolves the relic out of its family, failing the case when the family no
 * longer declares it.
 *
 * @returns The family's own frozen declaration.
 */
function blade(): Relic {
  const declared = BOARD_MANIPULATION_FAMILY.relics.find(
    (relic): boolean => relic.id === RELIC_ID,
  );

  expect(declared, `${RELIC_ID} is declared by its family`).toBeDefined();

  return declared as Relic;
}

/** The handler the relic binds to its one hook. */
function bladeHandler(): NonNullable<Relic['hooks']['onBeforeMove']> {
  const bound = blade().hooks.onBeforeMove;

  expect(bound, `${RELIC_ID} binds ${BOUND_HOOK}`).toBeTypeOf('function');

  return bound as NonNullable<Relic['hooks']['onBeforeMove']>;
}

/** The handler's source text, for the source-level discipline assertions. */
function handlerSource(): string {
  return String(bladeHandler());
}

/**
 * Assembles a bench over one board.
 *
 * `config` is a fresh `createDefaultRulesConfig()`, which is mutable at every
 * level; `DEFAULT_RULES_CONFIG` is the deep-frozen template and is not used
 * here. `environment.grid` and the dispatch payload's board are the same
 * object: src/engine/hook-bus.ts projects its board view from
 * `environment.grid`.
 *
 * @param board Board to play the case on.
 * @param options Seed, charge override and whether to seat the relic.
 * @returns The assembled bench.
 */
function bench(board: SerializedGameState, options: BenchOptions = {}): Bench {
  const size = board.grid.size;
  const config = createDefaultRulesConfig();

  config.boardSize = size;

  const grid = new Grid(size, board.grid.cells);
  const streams = createRngStreams(options.seed ?? SUITE_SEED);
  const bus = createHookBus({
    correlationId: SUITE_CORRELATION,
    reporter: NOOP_ENGINE_REPORTER,
  });

  if (options.seatRelic !== false) {
    seatBlade(bus, options.charges);
  }

  return {
    grid,
    config,
    streams,
    bus,
    environment: { config, rng: streams, grid },
  };
}

/**
 * Registers the relic with one bus, under its own identifier and handler
 * table.
 *
 * @param bus Bus to register with.
 * @param charges Budget to register with, defaulting to the declared one.
 */
function seatBlade(bus: HookBus, charges?: number): void {
  const declared = blade();
  const budget = charges ?? declared.charges;

  expect(
    bus.register({
      id: declared.id,
      hooks: declared.hooks,
      charges: budget,
      state: declared.state,
    }),
    `${RELIC_ID} registers`,
  ).toBe(true);
}

/* ==========================================================================
 * 4. Dispatch, with the cursor guard on every path
 * ========================================================================== */

/**
 * A before-move dispatch payload over one board, leftwards and uncancelled.
 *
 * @param grid Board the move is resolving against.
 * @returns The payload the bus is dispatched with.
 */
function beforeMove(grid: Grid): HookDispatchPayloadMap['onBeforeMove'] {
  return { direction: DIRECTION_LEFT, board: grid, cancelled: false };
}

/**
 * Asserts that not one of the four named substreams advanced.
 *
 * @param before Cursors as they stood before the dispatch.
 * @param after Cursors as they stand after it.
 */
function expectNoCursorMoved(
  before: RngCursorMap,
  after: RngCursorMap,
): void {
  for (const name of RNG_STREAM_NAMES) {
    expect(after[name], `${name} cursor`).toBe(before[name]);
  }

  expect(after).toEqual(before);
}

/**
 * Dispatches `onBeforeMove` against a bench and hands back the whole result,
 * asserting on the way out that no substream advanced.
 *
 * EVERY DISPATCH IN THIS SUITE GOES THROUGH HERE, so the cursor assertion
 * covers all four substreams around all of them.
 *
 * @param target Bench to dispatch on.
 * @returns The dispatch result.
 */
function dispatch(target: Bench): HookDispatchResult<'onBeforeMove'> {
  const before = target.streams.snapshotCursors();
  const result = target.bus.dispatch(
    BOUND_HOOK,
    beforeMove(target.grid),
    target.environment,
  );

  expectNoCursorMoved(before, target.streams.snapshotCursors());

  return result;
}

/**
 * Runs `use` inside a live dispatch, handing it the real payload and the real
 * context the bus mints: the collaborator views, the effect queue, the
 * correlation identifier and the state slot.
 *
 * `HookContext.effects` is opened by src/engine/board-effects.ts and resolved
 * by the bus once the handler returns, so the context handed over here is a
 * live one taken from a dispatch in progress and a direct call made through it
 * runs inside that same open transaction.
 *
 * @param target Bench to dispatch on.
 * @param use Receives the payload and the context, and returns any value.
 * @returns Whatever `use` returned.
 */
function withLiveContext<T>(
  target: Bench,
  use: (payload: BeforeMovePayload, context: HookContext) => T,
): T {
  const holder: { taken: readonly [T] | null } = { taken: null };

  expect(
    target.bus.register({
      id: PROBE_ID,
      hooks: {
        onBeforeMove: (payload, context): BeforeMovePayload => {
          holder.taken = [use(payload, context)];

          return payload;
        },
      },
    }),
    'the context probe registers',
  ).toBe(true);

  const result = dispatch(target);

  expect(target.bus.unregister(PROBE_ID), 'the probe detaches').toBe(true);
  expect(result.failed, 'no handler threw').toBe(0);
  expect(result.rejected, 'no return was refused').toBe(0);

  const taken = holder.taken;

  if (taken === null) {
    throw new Error('the context probe handler was never invoked');
  }

  return taken[0];
}

/* ==========================================================================
 * 5. Board readers and coherence
 * ========================================================================== */

/** One occupied cell, as this suite reads it back. */
interface Occupant {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/**
 * Every occupant of a board, in the grid's own scan order.
 *
 * @param grid Board to read.
 * @returns One entry per occupied cell.
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
 * The board's value multiset, ascending, which is what catches a removal of
 * the wrong tile that happens to leave the right count behind.
 *
 * @param grid Board to read.
 * @returns The sorted face values.
 */
function sortedValues(grid: Grid): number[] {
  return occupants(grid)
    .map((cell): number => cell.value)
    .sort((left, right): number => left - right);
}

/**
 * The live tile objects of a board, keyed by cell, for survivor identity.
 *
 * @param grid Board to read.
 * @returns A map from `x,y` to the tile standing there.
 */
function tilesByCell(grid: Grid): Map<string, Tile> {
  const held = new Map<string, Tile>();

  grid.eachCell((x, y, tile): void => {
    if (tile !== null) {
      held.set(`${x},${y}`, tile);
    }
  });

  return held;
}

/**
 * Asserts the lattice is internally coherent: square, holding only tiles or
 * `null`, every occupant's own coordinates agreeing with the slot it stands
 * in, no tile occupying two slots, and an off-lattice read still refused.
 *
 * @param grid Board to check.
 */
function expectCoherentLattice(grid: Grid): void {
  expect(grid.cells).toHaveLength(grid.size);

  const seen = new Set<Tile>();

  for (let x = 0; x < grid.size; x += 1) {
    const column = grid.cells[x];

    expect(column).toHaveLength(grid.size);

    for (let y = 0; y < grid.size; y += 1) {
      const slot = column[y];

      expect(slot === null || slot instanceof Tile).toBe(true);

      if (slot !== null) {
        expect(slot.x, `tile at ${x},${y} agrees on x`).toBe(x);
        expect(slot.y, `tile at ${x},${y} agrees on y`).toBe(y);
        expect(seen.has(slot), `tile at ${x},${y} occupies one slot`).toBe(
          false,
        );
        seen.add(slot);
      }
    }
  }

  expect(grid.cellContent({ x: grid.size, y: 0 })).toBeNull();
  expect(grid.cellContent({ x: 0, y: grid.size })).toBeNull();
  expect(grid.cellContent({ x: -1, y: 0 })).toBeNull();
}

/**
 * Asserts the board projects to the persisted shape and rebuilds from it
 * unchanged, empty cells included.
 *
 * @param grid Board to check.
 */
function expectSerializeRoundTrips(grid: Grid): void {
  const projected = grid.serialize();

  expect(projected.size).toBe(grid.size);
  expect(projected.cells).toHaveLength(grid.size);

  const rebuilt = new Grid(projected.size, projected.cells);

  expect(rebuilt.serialize()).toEqual(projected);
  expect(occupants(rebuilt)).toEqual(occupants(grid));
}

/* ==========================================================================
 * 6. Rule invariance
 * ========================================================================== */

/** The rule values one case holds the config to. */
interface RulesSnapshot {
  readonly boardSize: number;
  readonly winValue: number;
  readonly startTiles: number;
  readonly values: readonly number[];
  readonly weights: readonly number[];
  readonly canMerge: RulesConfig['merge']['canMerge'];
  readonly produce: RulesConfig['merge']['produce'];
}

/**
 * Takes the rules as they stand.
 *
 * @param config Rules in force.
 * @returns The snapshot the invariance assertion compares against.
 */
function ruleSnapshot(config: RulesConfig): RulesSnapshot {
  return {
    boardSize: config.boardSize,
    winValue: config.winValue,
    startTiles: config.startTiles,
    values: config.spawn.values.slice(),
    weights: config.spawn.weights.slice(),
    canMerge: config.merge.canMerge,
    produce: config.merge.produce,
  };
}

/**
 * Asserts every rule still stands where it stood.
 *
 * @param config Rules in force.
 * @param taken Snapshot taken before the dispatch.
 */
function expectRulesUnchanged(
  config: RulesConfig,
  taken: RulesSnapshot,
): void {
  expect(config.boardSize).toBe(taken.boardSize);
  expect(config.winValue).toBe(taken.winValue);
  expect(config.startTiles).toBe(taken.startTiles);
  expect(config.spawn.values).toEqual(taken.values);
  expect(config.spawn.weights).toEqual(taken.weights);
  expect(config.merge.canMerge).toBe(taken.canMerge);
  expect(config.merge.produce).toBe(taken.produce);
}

/**
 * The charge budget one bus holds for the relic.
 *
 * @param bus Bus to read.
 * @returns The budget, or `undefined` where the relic is unlimited or absent.
 */
function seatedCharges(bus: HookBus): number | undefined {
  return bus.subscribers().find((seat): boolean => seat.id === RELIC_ID)
    ?.charges;
}

/**
 * The state slot one bus holds for the relic.
 *
 * @param bus Bus to read.
 * @returns The slot as the bus holds it.
 */
function seatedState(bus: HookBus): unknown {
  return bus.subscribers().find((seat): boolean => seat.id === RELIC_ID)?.state;
}

/* ==========================================================================
 * 7. The declaration
 * ========================================================================== */

describe('the culling-blade declaration', () => {
  it('is carried by the board-manipulation family and by the catalogue', () => {
    const declared = blade();

    expect(BOARD_MANIPULATION_FAMILY.name).toBe('board-manipulation');
    expect(declared.id).toBe(RELIC_ID);
    expect(findRelicById(RELIC_ID)).toBe(declared);
  });

  it('carries a name, a rarity and a description', () => {
    const declared = blade();

    expect(declared.name).toBe('Culling Blade');
    expect(declared.rarity).toBe('rare');
    expect(declared.description.length).toBeGreaterThan(0);
  });

  it('declares a finite charge budget above zero', () => {
    const declared = blade();

    expect(declared.charges).toBeTypeOf('number');
    expect(Number.isFinite(declared.charges)).toBe(true);
    expect(declared.charges).toBe(DECLARED_CHARGES);
    expect(declared.charges as number).toBeGreaterThan(0);
  });

  it('is one of the five charge-bearing relics the catalogue declares', () => {
    const charged = RELIC_CATALOGUE.filter(
      (relic): boolean => relic.charges !== undefined,
    ).map((relic): string => relic.id);

    expect(charged).toContain(RELIC_ID);
    expect(charged).toHaveLength(CHARGE_BEARING_RELICS);
    expect(RELIC_CATALOGUE).toHaveLength(CATALOGUE_RELICS);
    expect(BOARD_MANIPULATION_FAMILY.relics).toHaveLength(FAMILY_RELICS);
  });

  it('declares no state slot, carrying its whole rule in its handler', () => {
    const declared = blade();

    expect('state' in declared).toBe(false);
    expect(declared.state).toBeUndefined();
  });
});

/* ==========================================================================
 * 8. Property 1: it fires only on the hook it binds
 * ========================================================================== */

describe('the hooks culling-blade binds', () => {
  it('binds onBeforeMove and no other hook', () => {
    expect(Object.keys(blade().hooks)).toEqual([BOUND_HOOK]);
  });

  it('binds only names the six-hook surface declares', () => {
    for (const name of Object.keys(blade().hooks)) {
      expect(HOOK_NAMES).toContain(name);
    }
  });

  it('leaves the other five hook names absent, not present-but-undefined',
    () => {
      const hooks = blade().hooks;

      for (const name of HOOK_NAMES) {
        if (name === BOUND_HOOK) {
          continue;
        }

        expect(name in hooks, `${name} is absent`).toBe(false);
        expect(
          Object.prototype.hasOwnProperty.call(hooks, name),
          `${name} is not an own key`,
        ).toBe(false);
      }
    });

  it('binds a function to the one hook it declares', () => {
    expect(blade().hooks.onBeforeMove).toBeTypeOf('function');
  });

  it('is invoked on onBeforeMove and reports one invocation', () => {
    const target = bench(armedBoard(4));
    const result = dispatch(target);

    expect(result.invoked).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.rejected).toBe(0);
  });

  it('keeps no module-level state: a later run repeats the first exactly',
    () => {
      const first = bench(armedBoard(4, 8));

      dispatch(first);
      dispatch(first);

      const exhausted = first.grid.serialize();

      // A bench built AFTER the first has run twice, on an identical board and
      // with its own state slot, must reproduce the first run step for step.
      const second = bench(armedBoard(4, 8));

      dispatch(second);

      const afterOne = second.grid.serialize();

      dispatch(second);

      expect(second.grid.serialize()).toEqual(exhausted);
      expect(afterOne).not.toEqual(exhausted);
      expect(seatedState(first.bus)).toBeUndefined();
      expect(seatedState(second.bus)).toBeUndefined();
    });
});

/* ==========================================================================
 * 9. Property 2: the specified effect, a deterministic excision
 * ========================================================================== */

describe('the excision culling-blade performs', () => {
  it('removes the single lowest face value on the board, wherever it stands',
    () => {
      // The arming count is read against the lowest SPAWN value, so raising
      // that distribution to [4, 8] arms the blade on fours and leaves the one
      // tile of value 2 as an unambiguous lowest, last in scan order.
      const target = bench(
        boardWith(4, [
          ...scanOrderPlacements(4, ARMING_TILES, 4),
          { x: 3, y: 3, value: 2 },
        ]),
      );

      target.config.spawn.values = [4, 8];
      target.config.spawn.weights = [0.9, 0.1];

      const result = dispatch(target);

      expect(result.effectsApplied).toBe(1);
      expect(target.grid.cellContent({ x: 3, y: 3 })).toBeNull();
      expect(sortedValues(target.grid)).toEqual([4, 4, 4, 4, 4, 4]);
      expectCoherentLattice(target.grid);
    });

  it('breaks a tie by the x-outer, y-inner scan order of the lattice', () => {
    // (0, 3) precedes (1, 0) in the x-outer walk of js/grid.js L58-L64 and
    // follows it in a row-major walk, so the cell taken names the order.
    const target = bench(
      boardWith(4, [
        { x: 0, y: 3, value: 2 },
        { x: 1, y: 0, value: 2 },
        { x: 1, y: 1, value: 2 },
        { x: 1, y: 2, value: 2 },
        { x: 1, y: 3, value: 2 },
        { x: 2, y: 0, value: 2 },
      ]),
    );

    dispatch(target);

    expect(target.grid.cellContent({ x: 0, y: 3 })).toBeNull();
    expect(target.grid.cellContent({ x: 1, y: 0 })?.value).toBe(2);
    expect(occupants(target.grid)).toHaveLength(ARMING_TILES - 1);
  });

  it('resolves to one identical board on every run of one built board', () => {
    const resolved: string[] = [];

    for (let run = 0; run < 4; run += 1) {
      const target = bench(armedBoard(4, 8));

      dispatch(target);
      resolved.push(JSON.stringify(target.grid.serialize()));
      expect(target.grid.cellContent({ x: 0, y: 0 })).toBeNull();
    }

    expect(new Set(resolved).size).toBe(1);
  });

  it('removes exactly one tile, and the multiset loses only that value', () => {
    const target = bench(
      boardWith(4, [
        ...scanOrderPlacements(4, ARMING_TILES, 2),
        { x: 2, y: 0, value: 1024 },
        { x: 2, y: 1, value: 512 },
      ]),
    );

    const before = sortedValues(target.grid);

    expect(before).toEqual([2, 2, 2, 2, 2, 2, 512, 1024]);

    dispatch(target);

    const after = sortedValues(target.grid);

    expect(after).toHaveLength(before.length - 1);
    expect(after).toEqual([2, 2, 2, 2, 2, 512, 1024]);
  });

  it('leaves every survivor at its original cell, as its original object',
    () => {
      const target = bench(armedBoard(4, 8));
      const before = tilesByCell(target.grid);
      const excised = '0,0';

      dispatch(target);

      const after = tilesByCell(target.grid);

      expect(after.has(excised)).toBe(false);
      expect(after.size).toBe(before.size - 1);

      for (const [cell, tile] of before) {
        if (cell === excised) {
          continue;
        }

        const survivor = after.get(cell);

        expect(survivor, `survivor at ${cell}`).toBe(tile);
        expect(survivor?.value).toBe(tile.value);
        expect(`${survivor?.x},${survivor?.y}`).toBe(cell);
      }
    });

  it('leaves the vacated cell available, listed, and null in the projection',
    () => {
      const target = bench(armedBoard(4, 8));

      dispatch(target);

      const vacated = { x: 0, y: 0 };

      expect(target.grid.cellAvailable(vacated)).toBe(true);
      expect(target.grid.cellOccupied(vacated)).toBe(false);
      expect(target.grid.availableCells()).toContainEqual(vacated);

      // js/grid.js L102-L117 retains an empty cell as `null` rather than
      // dropping it, so the column keeps its full length.
      const projected = target.grid.serialize();

      expect(projected.cells[0][0]).toBeNull();
      expect(projected.cells[0]).toHaveLength(4);
      expectSerializeRoundTrips(target.grid);
    });

  it('records its removal as a removeTile command the engine applies', () => {
    const target = bench(armedBoard(4, 8));
    const result = dispatch(target);

    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toEqual({
      kind: 'removeTile',
      cell: { x: 0, y: 0 },
    });
    expect(result.effectsApplied).toBe(1);
    expect(result.effectsRefused).toBe(0);
  });

  it('writes no cell of the lattice directly in its own source', () => {
    const source = handlerSource();

    // js/grid.js L93-L95 is the removal path, reached through the recorded
    // command above rather than by a subscript assignment here.
    expect(source).not.toMatch(/\bcells\s*\[/);
    expect(source).not.toMatch(/\[[^\]]*\]\s*=[^=]/);
    expect(source).not.toMatch(/\binsertTile\b/);
    expect(source).toMatch(/removeTile\s*\(/);
  });

  it('resolves the move as pressed, cancelling nothing', () => {
    const target = bench(armedBoard(4, 8));
    const result = dispatch(target);

    expect(result.payload.cancelled).toBe(false);
    expect(result.payload.direction).toBe(DIRECTION_LEFT);
  });

  it('returns the payload it was given rather than nothing', () => {
    const target = bench(armedBoard(4, 8), { seatRelic: false });
    const outcome = withLiveContext(target, (payload, context) => ({
      given: payload,
      returned: bladeHandler()(payload, context),
    }));

    expect(outcome.returned).toBe(outcome.given);
    expect(outcome.returned).toBeDefined();
  });

  it('changes no rule and carries no score to change', () => {
    const target = bench(armedBoard(4, 8));
    const taken = ruleSnapshot(target.config);
    const result = dispatch(target);

    expectRulesUnchanged(target.config, taken);

    // The before-move payload carries no score member at all, which is what
    // "awards no score" means on this hook.
    expect(Object.keys(result.payload).sort()).toEqual([
      'board',
      'cancelled',
      'direction',
    ]);
    expect(handlerSource()).not.toMatch(/\bscore\b/);
  });
});

/* ==========================================================================
 * 10. Property 2, continued: the win and loss evaluation after an excision
 * ========================================================================== */

describe('the terminal-state verdict after an excision', () => {
  it('is recomputed from the thinned board, not from the board before it',
    () => {
      // Six tiles at the lowest spawn value arm the blade. Exactly two of them
      // are adjacent, and the blade takes the earlier of that pair, so the
      // board's only adjacent equal pair is the one the excision destroys.
      const target = bench(
        boardWith(4, [
          { x: 0, y: 0, value: 2 },
          { x: 0, y: 1, value: 2 },
          { x: 1, y: 2, value: 2 },
          { x: 2, y: 0, value: 2 },
          { x: 2, y: 3, value: 2 },
          { x: 3, y: 2, value: 2 },
        ]),
      );

      // js/game_manager.js L243-L268's neighbour probe, reached through the
      // exported function rather than restated here.
      expect(tileMatchesAvailable(target.grid, target.config)).toBe(true);
      expect(movesAvailable(target.grid, target.config)).toBe(true);

      dispatch(target);

      expect(target.grid.cellContent({ x: 0, y: 0 })).toBeNull();
      expect(tileMatchesAvailable(target.grid, target.config)).toBe(false);

      // js/game_manager.js L238-L240 is `cellsAvailable() ||
      // tileMatchesAvailable()`, and the excision only widens the first half.
      expect(target.grid.cellsAvailable()).toBe(true);
      expect(movesAvailable(target.grid, target.config)).toBe(true);
      expectCoherentLattice(target.grid);
    });

  it('reads the live board dimension, so a vacated cell counts as room', () => {
    const target = bench(armedBoard(4, 8));

    dispatch(target);

    const empty = target.grid.availableCells();

    expect(empty).toHaveLength(4 * 4 - 7);
    expect(empty).toContainEqual({ x: 0, y: 0 });
    expect(movesAvailable(target.grid, target.config)).toBe(true);
  });

  it('is left exactly as the move found it on the full near-loss board', () => {
    // The near-loss fixture has no empty cell, so the blade is below its
    // opening condition and must take nothing at all.
    const target = bench(createNearLossBoard());
    const before = target.grid.serialize();

    expect(occupants(target.grid)).toHaveLength(4 * 4);
    expect(target.grid.cellsAvailable()).toBe(false);
    expect(tileMatchesAvailable(target.grid, target.config)).toBe(true);

    const result = dispatch(target);

    expect(result.effectsApplied).toBe(0);
    expect(target.grid.serialize()).toEqual(before);
    expect(movesAvailable(target.grid, target.config)).toBe(true);
    expect(seatedCharges(target.bus)).toBe(DECLARED_CHARGES);
    expectCoherentLattice(target.grid);
  });
});

/* ==========================================================================
 * 11. Property 2, continued: degenerate boards
 * ========================================================================== */

describe('boards the blade must leave alone', () => {
  it('fabricates no tile on the empty fixture', () => {
    const target = bench(createEmptyBoard());
    const result = dispatch(target);

    expect(occupants(target.grid)).toHaveLength(0);
    expect(result.effectsApplied).toBe(0);
    expect(result.failed).toBe(0);
    expect(target.grid.availableCells()).toHaveLength(4 * 4);
    expectCoherentLattice(target.grid);
    expectSerializeRoundTrips(target.grid);
  });

  it('takes nothing from the merge-pair fixture, below the arming count',
    () => {
      const target = bench(createMergePairBoard());
      const before = target.grid.serialize();

      expect(occupants(target.grid)).toHaveLength(2);

      const result = dispatch(target);

      expect(result.effectsApplied).toBe(0);
      expect(target.grid.serialize()).toEqual(before);
      expect(seatedCharges(target.bus)).toBe(DECLARED_CHARGES);
    });

  it('takes nothing from the blocked fixture, whose column holds one 2', () => {
    const target = bench(createBlockedBoard());
    const before = target.grid.serialize();

    expect(sortedValues(target.grid)).toEqual([2, 4, 8, 16]);

    const result = dispatch(target);

    expect(result.effectsApplied).toBe(0);
    expect(target.grid.serialize()).toEqual(before);
    expectCoherentLattice(target.grid);
  });

  it('takes nothing from a board holding exactly one tile', () => {
    const target = bench(boardWith(4, [{ x: 2, y: 2, value: 2 }]));
    const result = dispatch(target);

    expect(result.effectsApplied).toBe(0);
    expect(result.failed).toBe(0);
    expect(occupants(target.grid)).toEqual([{ x: 2, y: 2, value: 2 }]);
    expectCoherentLattice(target.grid);
  });

  it('takes nothing one tile short of the arming count', () => {
    const target = bench(armedBoard(4, ARMING_TILES - 1));
    const before = target.grid.serialize();
    const result = dispatch(target);

    expect(result.invoked).toBe(1);
    expect(result.effectsApplied).toBe(0);
    expect(target.grid.serialize()).toEqual(before);
  });

  it('takes nothing when the spawn distribution declares no usable value',
    () => {
      const target = bench(armedBoard(4, 8));

      target.config.spawn.values = [];
      target.config.spawn.weights = [];

      const before = target.grid.serialize();
      const result = dispatch(target);

      expect(result.failed).toBe(0);
      expect(result.effectsApplied).toBe(0);
      expect(target.grid.serialize()).toEqual(before);
    });
});

/* ==========================================================================
 * 12. Property 2, continued: the live board dimension
 * ========================================================================== */

describe('the board dimension the blade reads', () => {
  it('holds off at 3 by 3, where the arming count exceeds the open band',
    () => {
      const size = SMALL_BOARD_SIZE;
      const target = bench(armedBoard(size, ARMING_TILES));
      const before = target.grid.serialize();

      expect(target.config.boardSize).toBe(size);
      expect(target.grid.availableCells()).toHaveLength(
        size * size - ARMING_TILES,
      );
      expect(target.grid.availableCells().length).toBeLessThanOrEqual(
        scarcityBand(size),
      );

      const result = dispatch(target);

      expect(result.effectsApplied).toBe(0);
      expect(target.grid.serialize()).toEqual(before);
      expectCoherentLattice(target.grid);
    });

  it('acts at 5 by 5, whose open band the same layout clears', () => {
    const size = LARGE_BOARD_SIZE;
    const target = bench(armedBoard(size, ARMING_TILES));

    expect(target.config.boardSize).toBe(size);
    expect(target.grid.availableCells().length).toBeGreaterThan(
      scarcityBand(size),
    );

    const result = dispatch(target);

    expect(result.effectsApplied).toBe(1);
    expect(target.grid.cellContent({ x: 0, y: 0 })).toBeNull();
    expect(occupants(target.grid)).toHaveLength(ARMING_TILES - 1);
    expect(target.grid.size).toBe(size);
    expectCoherentLattice(target.grid);
    expectSerializeRoundTrips(target.grid);
  });

  it('holds off at 5 by 5 once the board fills past that same band', () => {
    const size = LARGE_BOARD_SIZE;
    const occupied = size * size - scarcityBand(size);
    const target = bench(armedBoard(size, occupied));
    const before = target.grid.serialize();

    expect(target.grid.availableCells()).toHaveLength(scarcityBand(size));

    const result = dispatch(target);

    expect(result.effectsApplied).toBe(0);
    expect(target.grid.serialize()).toEqual(before);
  });
});

/* ==========================================================================
 * 13. Property 3: charges, and the zero-charge case
 * ========================================================================== */

describe('the charge budget culling-blade draws on', () => {
  it('is never read, compared or written by the handler itself', () => {
    const source = handlerSource();

    // The guard and the deduction both live in src/engine/hook-bus.ts; the
    // handler's only charge vocabulary is the request.
    expect(source).not.toMatch(/\bcharges\b/);
    expect(source).not.toMatch(/\bconsumeCharge\b/);
    expect(source).toMatch(/spendCharge\s*\(/);
  });

  it('owns no error handling and no logging of its own', () => {
    const source = handlerSource();

    expect(source).not.toMatch(/\bcatch\b/);
    expect(source).not.toMatch(/\btry\b/);
    expect(source).not.toMatch(/\bconsole\b/);
  });

  it('is spent only on the turn the excision was actually recorded', () => {
    const acting = bench(armedBoard(4, 8));

    dispatch(acting);

    expect(seatedCharges(acting.bus)).toBe(DECLARED_CHARGES - 1);

    const idle = bench(armedBoard(4, ARMING_TILES - 1));

    dispatch(idle);

    expect(seatedCharges(idle.bus)).toBe(DECLARED_CHARGES);
  });

  it('neither throws nor corrupts the board when invoked at zero charges',
    () => {
      const target = bench(armedBoard(4, 8), { seatRelic: false });
      const taken = ruleSnapshot(target.config);
      const outcome = withLiveContext(target, (payload, context) => {
        const spent: HookContext = { ...context, charges: 0 };

        return { given: payload, returned: bladeHandler()(payload, spent) };
      });

      expect(outcome.returned).toBe(outcome.given);
      expect(occupants(target.grid)).toHaveLength(7);
      expectCoherentLattice(target.grid);
      expectSerializeRoundTrips(target.grid);
      expectRulesUnchanged(target.config, taken);
      expect(seatedCharges(target.bus)).toBeUndefined();
      expect(seatedState(target.bus)).toBeUndefined();

      // Nothing was poisoned by that call: a normally seated dispatch on the
      // same bus and the same board still excises, and still pays for it.
      seatBlade(target.bus);

      const result = dispatch(target);

      expect(result.effectsApplied).toBe(1);
      expect(occupants(target.grid)).toHaveLength(6);
      expect(seatedCharges(target.bus)).toBe(DECLARED_CHARGES - 1);
    });

  it('behaves identically when invoked at a negative charge count', () => {
    // src/relics/relic-registry.ts restores a persisted budget without
    // clamping, so a negative count is reachable from storage.
    const target = bench(armedBoard(4, 8), { seatRelic: false });
    const taken = ruleSnapshot(target.config);
    const outcome = withLiveContext(target, (payload, context) => {
      const negative: HookContext = { ...context, charges: -3 };

      return { given: payload, returned: bladeHandler()(payload, negative) };
    });

    expect(outcome.returned).toBe(outcome.given);
    expect(occupants(target.grid)).toHaveLength(7);
    expect(target.grid.cellContent({ x: 0, y: 0 })).toBeNull();
    expectCoherentLattice(target.grid);
    expectSerializeRoundTrips(target.grid);
    expectRulesUnchanged(target.config, taken);

    seatBlade(target.bus, DECLARED_CHARGES);

    expect(dispatch(target).effectsApplied).toBe(1);
    expect(occupants(target.grid)).toHaveLength(6);
  });

  it('stops excising once a run has spent the budget, and never throws', () => {
    const target = bench(armedBoard(4, 8), { seatRelic: false });
    const registry = new RelicRegistry({
      bus: target.bus,
      reporter: NOOP_ENGINE_REPORTER,
      correlationId: SUITE_CORRELATION,
    });

    expect(registry.pickUp(RELIC_ID)?.definition.id).toBe(RELIC_ID);
    expect(registry.find(RELIC_ID)?.charges).toBe(DECLARED_CHARGES);

    const counted = [occupants(target.grid).length];

    for (let turn = 0; turn < 4; turn += 1) {
      const result = dispatch(target);

      expect(result.failed, `turn ${turn} threw nothing`).toBe(0);
      counted.push(occupants(target.grid).length);
    }

    // Two excisions, then a board the blade still finds armed and can no
    // longer act on.
    expect(counted).toEqual([8, 7, 6, 6, 6]);
    expect(registry.find(RELIC_ID)?.charges).toBe(0);
    expect(seatedCharges(target.bus)).toBe(0);
    expect(target.grid.availableCells().length).toBeGreaterThan(
      scarcityBand(4),
    );
    expectCoherentLattice(target.grid);
  });

  it('leaves the run records readable after the budget is spent', () => {
    const target = bench(armedBoard(4, 8), { seatRelic: false });
    const registry = new RelicRegistry({
      bus: target.bus,
      reporter: NOOP_ENGINE_REPORTER,
      correlationId: SUITE_CORRELATION,
    });

    registry.pickUp(RELIC_ID);
    dispatch(target);
    dispatch(target);
    dispatch(target);

    const persisted = registry.persistedEntry(RELIC_ID);

    expect(persisted?.id).toBe(RELIC_ID);
    expect(persisted?.charges).toBe(0);
    expect(() => JSON.stringify(registry.serialize())).not.toThrow();
    expect(registry.degradedIds()).toEqual([]);
  });
});

/* ==========================================================================
 * 14. RNG freedom, the property that distinguishes this relic
 * ========================================================================== */

describe('the randomness culling-blade consumes', () => {
  it('leaves all four named substream cursors exactly where they stood', () => {
    const target = bench(armedBoard(4, 8));
    const before = target.streams.snapshotCursors();

    dispatch(target);
    dispatch(target);
    dispatch(target);

    const after = target.streams.snapshotCursors();

    for (const name of RNG_STREAM_NAMES) {
      expect(after[name], `${name} cursor`).toBe(before[name]);
      expect(after[name], `${name} cursor`).toBe(0);
    }

    expect(after).toEqual(before);
    expect(RNG_STREAM_NAMES).toHaveLength(4);
  });

  it('resolves one identical board under two different run seeds', () => {
    const first = bench(armedBoard(4, 8), { seed: SUITE_SEED });
    const second = bench(armedBoard(4, 8), { seed: ALTERNATE_SEED });

    expect(first.streams.seed).not.toBe(second.streams.seed);

    dispatch(first);
    dispatch(second);

    expect(second.grid.serialize()).toEqual(first.grid.serialize());

    dispatch(first);
    dispatch(second);

    expect(second.grid.serialize()).toEqual(first.grid.serialize());
    expect(second.streams.snapshotCursors()).toEqual(
      first.streams.snapshotCursors(),
    );
  });

  it('reaches for no generator, no substream and no draw in its source', () => {
    const source = handlerSource();

    expect(source).not.toMatch(/Math\s*\.\s*random/);
    expect(source).not.toMatch(/\brandom\b/);
    expect(source).not.toMatch(/\brng\b/);
    expect(source).not.toMatch(/\bstream\s*\(/);
    expect(source).not.toMatch(/\bnextInt\b/);
    expect(source).not.toMatch(/\bnextFloat\b/);
    expect(source).not.toMatch(/\bpickWeighted\b/);
    expect(source).not.toMatch(/\bpick\s*\(/);
    expect(source).not.toMatch(/\bsnapshotCursors\b/);
  });

  it('reads no clock and starts no timer in its source', () => {
    const source = handlerSource();

    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/\bnow\s*\(/);
    expect(source).not.toMatch(/\bsetTimeout\b/);
    expect(source).not.toMatch(/\bperformance\b/);
  });
});

/* ==========================================================================
 * 15. The declaration, after everything above has run
 * ========================================================================== */

describe('the catalogue declaration once the suite has run', () => {
  it('still declares the same budget, the same hook and no state', () => {
    const declared = blade();

    expect(declared.charges).toBe(DECLARED_CHARGES);
    expect(Object.keys(declared.hooks)).toEqual([BOUND_HOOK]);
    expect(declared.hooks.onBeforeMove).toBe(bladeHandler());
    expect('state' in declared).toBe(false);
  });

  it('is still frozen at the declaration and at its handler table', () => {
    const declared = blade();

    expect(Object.isFrozen(declared)).toBe(true);
    expect(Object.isFrozen(declared.hooks)).toBe(true);
    expect(Object.isFrozen(BOARD_MANIPULATION_FAMILY)).toBe(true);
    expect(Object.isFrozen(BOARD_MANIPULATION_FAMILY.relics)).toBe(true);
  });
});
