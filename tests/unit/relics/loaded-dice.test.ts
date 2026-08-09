// Per-relic suite for `loaded-dice`, the `spawn-control` relic that inverts
// the configured spawn distribution. AAP requirement R3, and the one relic
// carrying validation gate V6 row 5: an RNG-affecting relic stays
// deterministic under a fixed seed.
//
// Three mandatory properties, one describe block apiece, followed by the
// determinism and substream-hygiene block the gate turns on and a closing
// integrity block.
//
// The absent-position dispatch below is the boundary at js/grid.js L37-L43,
// where `randomAvailableCell` carries no else branch and so yields no cell.
//
// Every seed is a fixed literal. Nothing here reads a document, a clock,
// `Math.random` or a timer, and this suite runs under `npm test` with no
// server, browser or network.
//
// Decisions: DL-SPAWN-01, DL-SPAWN-02, DL-DRAW-02, DL-RELIC-01, DL-RNG-04
// (docs/DECISION_LOG.md).

import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  HookContext,
  HookHandler,
  HookName,
  SpawnPayload,
} from '../../../src/engine/hooks';
import type {
  CorrelationId,
  SerializedGameState,
} from '../../../src/engine/types';
import {
  SPAWN_CONTROL_FAMILY,
} from '../../../src/relics/families/spawn-control';
import { findRelicById } from '../../../src/relics/relic-registry';
import type { Relic } from '../../../src/relics/relic-types';
import { createRngStreams } from '../../../src/rng/rng-streams';
import type {
  RngCursorMap,
  RngStreams,
  StreamName,
} from '../../../src/rng/rng-streams';
import {
  createMergePairBoard,
  createNearLossBoard,
} from '../../fixtures/boards';

/** Identifier the family declares and the catalogue indexes. */
const RELIC_ID = 'loaded-dice';

/** The one hook this relic binds. */
const SPAWN_HOOK: HookName = 'onSpawn';

/** Hook names the declaration is expected to carry, and no others. */
const BOUND_HOOKS: readonly HookName[] = [SPAWN_HOOK];

/** Substream the family contract states every handler draw comes from. */
const DRAW_STREAM: StreamName = 'relic-draw';

/**
 * Substreams a value re-draw must leave standing: the engine's own two, and
 * the tier stream a reward offer consumes.
 */
const UNMOVED_STREAMS: readonly StreamName[] = [
  'spawn-value',
  'spawn-position',
  'rarity-weight',
];

/** Run seed every bench is built from unless a test names another. */
const PRIMARY_SEED = 'loaded-dice-fixed';

/**
 * Second run seed. Its ten-dispatch sequence differs from `PRIMARY_SEED`'s in
 * at least one position, so the different-seed assertion is not vacuous.
 */
const ALTERNATE_SEED = 'loaded-dice-divergent';

/** Dispatches per sequence in the determinism assertions. */
const DISPATCH_COUNT = 10;

/** Run correlation identifier every dispatch carries, per Rule 3. */
const CORRELATION_ID: CorrelationId = 'run-loaded-dice-suite';

/** Acquisition position the notional subscription holds. */
const PICKUP_ORDER = 0;

/** Value the rules hand the dispatch: the vanilla common value. */
const INCOMING_VALUE = 2;

/** Tile count a vanilla spawn inserts, from js/game_manager.js L183. */
const INCOMING_COUNT = 1;

/** The ported vanilla spawn values, from js/game_manager.js L71. */
const VANILLA_SPAWN_VALUES: readonly number[] = [2, 4];

/** The ported vanilla spawn weights, from js/game_manager.js L71. */
const VANILLA_SPAWN_WEIGHTS: readonly number[] = [0.9, 0.1];

/** A three-entry distribution, wider than the vanilla pair. */
const THREE_VALUE_SPAWN: readonly number[] = [2, 4, 8];

/** Weights of `THREE_VALUE_SPAWN`, reversing to `[0.1, 0.2, 0.7]`. */
const THREE_VALUE_WEIGHTS: readonly number[] = [0.7, 0.2, 0.1];

/** A four-entry distribution, wide enough to separate reversal from a swap. */
const FOUR_VALUE_SPAWN: readonly number[] = [2, 4, 8, 16];

/** Weights placing all of the mass on the third entry. */
const THIRD_ENTRY_WEIGHTS: readonly number[] = [0, 0, 1, 0];

/** A single-entry distribution, whose reversal is the identity. */
const SINGLE_VALUE_SPAWN: readonly number[] = [2];

/** Weight of `SINGLE_VALUE_SPAWN`. */
const SINGLE_VALUE_WEIGHTS: readonly number[] = [1];

/**
 * One weight vector that is ALIGNED with `THREE_VALUE_SPAWN` — three entries,
 * none missing — and that a weighted draw still cannot select from.
 */
interface UnusableWeights {
  /** How the vector is unusable, named in the case title. */
  readonly name: string;
  readonly weights: readonly number[];
}

/**
 * The four aligned vectors `totalWeightOf` of src/rng/rng-streams.ts refuses:
 * a total of zero, a negative entry, an entry that is not a number, and a total
 * that is not finite. Each refusal is measured before a draw is taken.
 */
const UNUSABLE_WEIGHT_VECTORS: readonly UnusableWeights[] = Object.freeze([
  { name: 'a vector of zeroes', weights: Object.freeze([0, 0, 0]) },
  { name: 'a negative weight', weights: Object.freeze([0.5, -0.2, 0.7]) },
  { name: 'a NaN weight', weights: Object.freeze([0.5, Number.NaN, 0.5]) },
  {
    name: 'an infinite weight',
    weights: Object.freeze([0.5, Number.POSITIVE_INFINITY, 0.5]),
  },
]);

/* ==========================================================================
 * Harness: the declaration, and the HookContext built member by member
 * ========================================================================== */

/**
 * @returns The `loaded-dice` declaration.
 */
function catalogueRelic(): Relic {
  const relic = findRelicById(RELIC_ID);

  if (relic === undefined) {
    throw new Error(`The relic catalogue carries no ${RELIC_ID}.`);
  }

  return relic;
}

/**
 * Reads the declaration from its own family, by identifier.
 *
 * @returns The `loaded-dice` declaration as the family declares it.
 */
function familyRelic(): Relic {
  const relic = SPAWN_CONTROL_FAMILY.relics.find(
    (entry) => entry.id === RELIC_ID,
  );

  if (relic === undefined) {
    throw new Error(`The spawn-control family declares no ${RELIC_ID}.`);
  }

  return relic;
}

/**
 * @returns The handler the declaration binds to `onSpawn`.
 */
function spawnHandler(): HookHandler<'onSpawn'> {
  const handler = catalogueRelic().hooks.onSpawn;

  if (typeof handler !== 'function') {
    throw new Error(`${RELIC_ID} binds no onSpawn handler.`);
  }

  return handler;
}

/**
 * Wraps a live `Grid` as the query-only board view a dispatch carries.
 *
 * @param grid Live board to read through.
 * @returns The capability view of that board.
 */
function readonlyGrid(grid: Grid): HookContext['grid'] {
  return {
    get size(): number {
      return grid.size;
    },

    withinBounds: (position) => grid.withinBounds(position),
    cellAvailable: (cell) => grid.cellAvailable(cell),
    cellOccupied: (cell) => grid.cellOccupied(cell),
    cellValue: (cell) => grid.cellContent(cell)?.value ?? null,
    availableCells: () => grid.availableCells(),
    cellsAvailable: () => grid.cellsAvailable(),
    serialize: () => grid.serialize(),
  };
}

/** A board-command queue that records every write it is handed. */
interface EffectRecorder {
  /** Names of the commands recorded, in call order. */
  readonly commands: string[];

  /** The queue a dispatch carries. */
  readonly queue: HookContext['effects'];
}

/**
 * Builds a recording board-command queue over a board view.
 *
 * @param view Board view the read members delegate to.
 * @param size Edge length the queue reports.
 * @returns The recorder and its queue.
 */
function recordingEffects(
  view: HookContext['grid'],
  size: number,
): EffectRecorder {
  const commands: string[] = [];

  function record(name: string): boolean {
    commands.push(name);

    return true;
  }

  const queue: HookContext['effects'] = {
    size,

    get length(): number {
      return commands.length;
    },

    get refused(): number {
      return 0;
    },

    insertTile: () => record('insertTile'),
    removeTile: () => record('removeTile'),
    moveTile: () => record('moveTile'),
    restoreBoard: () => record('restoreBoard'),
    resizeBoard: () => record('resizeBoard'),
    setMergePredicate: () => record('setMergePredicate'),
    setSpawnWeights: () => record('setSpawnWeights'),
    request: () => record('request'),
    requested: () => [],
    cellValue: (cell) => view.cellValue(cell),
    cellOccupied: (cell) => view.cellOccupied(cell),
    availableCells: () => view.availableCells(),
    occupiedCells: () => [],

    clear: () => {
      commands.push('clear');
    },
  };

  return { commands, queue };
}

/** What a bench may be built with. Every member has a fixed default. */
interface BenchOptions {
  /** Run seed. Defaults to `PRIMARY_SEED`. */
  readonly seed?: string;

  /**
   * Charge budget the notional subscription carries. Absent by default, which
   * is the budget a relic declaring none holds.
   */
  readonly charges?: number;

  /** Board the view reads. Defaults to the merge-pair fixture. */
  readonly board?: SerializedGameState;
}

/** One dispatch environment, every collaborator reachable for assertion. */
interface Bench {
  /** Seed the substreams were derived from. */
  readonly seed: string;

  /** The live, unfrozen rules the dispatch reads. */
  readonly config: RulesConfig;

  /** The live board the view reads. */
  readonly grid: Grid;

  /** The run's four named substreams. */
  readonly streams: RngStreams;

  /** The context handed to the handler. */
  readonly context: HookContext;

  /** Board commands recorded during the bench's lifetime. */
  readonly commands: readonly string[];

  /** Charge amounts requested during the bench's lifetime. */
  readonly chargeRequests: readonly number[];
}

/**
 * Builds one dispatch environment: a fresh unfrozen `RulesConfig`, a live
 * `Grid` rehydrated from a fixture board, the four substreams of one seed, a
 * recording command queue, the run correlation identifier and an empty state
 * slot.
 *
 * @param options Fixed inputs to override.
 * @returns The bench.
 */
function createBench(options: BenchOptions = {}): Bench {
  const seed = options.seed ?? PRIMARY_SEED;
  const config = createDefaultRulesConfig();
  const board = options.board ?? createMergePairBoard(config.boardSize);
  const grid = new Grid(board.grid.size, board.grid.cells);
  const streams = createRngStreams(seed);
  const view = readonlyGrid(grid);
  const effects = recordingEffects(view, config.boardSize);
  const chargeRequests: number[] = [];

  const context: HookContext = {
    config,
    rng: streams,
    grid: view,
    effects: effects.queue,
    correlationId: CORRELATION_ID,
    hook: SPAWN_HOOK,
    subscriberId: RELIC_ID,
    pickupOrder: PICKUP_ORDER,
    charges: options.charges,

    spendCharge: (amount = 1) => {
      chargeRequests.push(amount);

      return false;
    },

    state: undefined,
  };

  return {
    seed,
    config,
    grid,
    streams,
    context,
    commands: effects.commands,
    chargeRequests,
  };
}

/**
 * Builds a spawn payload carrying a cell.
 *
 * @param x Column the engine resolved.
 * @param y Row the engine resolved.
 * @param value Value the rules produced.
 * @returns The payload.
 */
function spawnAt(x: number, y: number, value: number): SpawnPayload {
  return { position: { x, y }, value, count: INCOMING_COUNT };
}

/**
 * Builds a spawn payload carrying NO cell, the js/grid.js L37-L43 boundary.
 *
 * @param value Value the rules produced.
 * @returns The payload.
 */
function spawnWithoutCell(value: number): SpawnPayload {
  return { value };
}

/**
 * @param bench Environment to dispatch on.
 * @param payload Spawn the rules resolved.
 * @returns The payload the handler resolved to.
 */
function dispatch(bench: Bench, payload: SpawnPayload): SpawnPayload {
  const resolved = spawnHandler()(payload, bench.context);

  if (resolved === undefined) {
    throw new Error(`${RELIC_ID} resolved its onSpawn dispatch to nothing.`);
  }

  return resolved;
}

/**
 * Draws from a PARALLEL substream standing exactly where the live one stood,
 * built from the same seed and fast-forwarded to the recorded cursors.
 *
 * @param seed Run seed the live substreams were derived from.
 * @param cursors Cursor snapshot taken before the live dispatch.
 * @param values Candidate values, read in index order.
 * @param weights Weights, read in the same index order.
 * @returns The value that draw selects, or `undefined` where the shape
 *   admits no selection.
 */
function parallelPick(
  seed: string,
  cursors: RngCursorMap,
  values: readonly number[],
  weights: readonly number[],
): number | undefined {
  return createRngStreams(seed, cursors)
    .stream(DRAW_STREAM)
    .pickWeighted(values, weights);
}

/**
 * Reverses a weight vector on a copy, leaving the argument as it stands.
 *
 * @param weights Vector to reverse.
 * @returns A fresh reversed vector.
 */
function reversedWeights(weights: readonly number[]): number[] {
  return weights.slice().reverse();
}

/**
 * Swaps the first and last entries of a weight vector on a copy, leaving every
 * interior entry where it is.
 *
 * @param weights Vector to swap the ends of.
 * @returns A fresh vector with its ends exchanged.
 */
function endSwappedWeights(weights: readonly number[]): number[] {
  const swapped = weights.slice();
  const last = swapped.length - 1;
  const first = swapped[0];

  swapped[0] = swapped[last];
  swapped[last] = first;

  return swapped;
}

/**
 * @param bench Environment whose rules are replaced.
 * @param values Values to install.
 * @param weights Weights to install.
 */
function installDistribution(
  bench: Bench,
  values: readonly number[],
  weights: readonly number[],
): void {
  bench.config.spawn.values = [...values];
  bench.config.spawn.weights = [...weights];
}

/**
 * Compares two number vectors element by element, length first.
 *
 * @param actual Vector observed.
 * @param expected Vector required.
 */
function expectSameNumbers(
  actual: readonly number[],
  expected: readonly number[],
): void {
  expect(actual.length).toBe(expected.length);

  for (let index = 0; index < expected.length; index += 1) {
    expect(actual[index]).toBe(expected[index]);
  }
}

/**
 * Asserts that every substream a value re-draw must not touch stands exactly
 * where it stood.
 *
 * @param before Cursor snapshot taken before the dispatch.
 * @param after Cursor snapshot taken after it.
 */
function expectUnmovedStreams(
  before: RngCursorMap,
  after: RngCursorMap,
): void {
  for (const name of UNMOVED_STREAMS) {
    expect(after[name]).toBe(before[name]);
  }
}

/**
 * Reads the bound handler's own source text, for the assertions that a
 * construct is absent from it.
 *
 * @returns The handler's source.
 */
function handlerSource(): string {
  return spawnHandler().toString();
}

/**
 * Resolves a sequence of spawns on one fresh bench, so each dispatch draws
 * from the position the one before it left.
 *
 * @param seed Run seed to build the bench from.
 * @param count Dispatches to resolve.
 * @returns The values resolved, in dispatch order.
 */
function sequenceFrom(seed: string, count: number): number[] {
  const target = createBench({ seed });
  const resolved: number[] = [];

  for (let index = 0; index < count; index += 1) {
    resolved.push(dispatch(target, spawnAt(0, 0, INCOMING_VALUE)).value);
  }

  return resolved;
}

/**
 * Reads the declaration's members into a frozen record, for comparison against
 * the same object later.
 *
 * @returns A snapshot of the six declaration members.
 */
function declarationSnapshot(): {
  readonly id: string;
  readonly name: string;
  readonly rarity: string;
  readonly description: string;
  readonly hookKeys: readonly string[];
  readonly handler: HookHandler<'onSpawn'> | undefined;
} {
  const relic = catalogueRelic();

  return Object.freeze({
    id: relic.id,
    name: relic.name,
    rarity: relic.rarity,
    description: relic.description,
    hookKeys: Object.freeze(Object.keys(relic.hooks)),
    handler: relic.hooks.onSpawn,
  });
}

/**
 * The declaration as it stood when this module was imported, for the closing
 * assertion that the suite left the shared catalogue object alone.
 */
const DECLARATION_AT_IMPORT = declarationSnapshot();

/** Rebuilt before every test, so no test reads a config another one wrote. */
let bench: Bench = createBench();

beforeEach(() => {
  bench = createBench();
});

describe('loaded-dice is declared once and reachable by identifier', () => {
  it('resolves to the same frozen object through its family and the '
    + 'catalogue', () => {
    expect(catalogueRelic()).toBe(familyRelic());
    expect(Object.isFrozen(catalogueRelic())).toBe(true);
    expect(Object.isFrozen(catalogueRelic().hooks)).toBe(true);
  });

  it('carries the identifier, rarity and description the family declares',
    () => {
      const relic = catalogueRelic();

      expect(relic.id).toBe(RELIC_ID);
      expect(relic.name).toBe('Loaded Dice');
      expect(relic.rarity).toBe('legendary');
      expect(relic.description.length).toBeGreaterThan(0);
    });
});

describe('loaded-dice binds onSpawn and fires on no other hook', () => {
  it('declares exactly the onSpawn key in its handler table', () => {
    expect(Object.keys(catalogueRelic().hooks)).toEqual([...BOUND_HOOKS]);
  });

  it('declares only keys the engine lists in HOOK_NAMES', () => {
    for (const key of Object.keys(catalogueRelic().hooks)) {
      expect(HOOK_NAMES).toContain(key);
    }
  });

  it('leaves every unbound hook name absent from the table rather than '
    + 'present and undefined', () => {
    const hooks = catalogueRelic().hooks;
    const unbound = HOOK_NAMES.filter((name) => !BOUND_HOOKS.includes(name));

    expect(unbound.length).toBe(HOOK_NAMES.length - BOUND_HOOKS.length);

    for (const name of unbound) {
      expect(name in hooks).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(hooks, name)).toBe(false);
    }
  });

  it('binds a function at every key it declares', () => {
    const hooks = catalogueRelic().hooks;
    const keys = Object.keys(hooks) as HookName[];

    expect(keys.length).toBe(BOUND_HOOKS.length);

    for (const key of keys) {
      expect(typeof hooks[key]).toBe('function');
    }
  });
});

describe('loaded-dice re-draws the spawn value with the live config spawn '
  + 'weights reversed', () => {
  it('resolves to the value the reversed weights select at that cursor, and '
    + 'not to the value the weights as configured select', () => {
    const values = [...bench.config.spawn.values];
    const weights = [...bench.config.spawn.weights];
    const before = bench.streams.snapshotCursors();

    const resolved = dispatch(bench, spawnAt(1, 2, INCOMING_VALUE));

    const reversedPick = parallelPick(
      bench.seed,
      before,
      values,
      reversedWeights(weights),
    );
    const configuredPick = parallelPick(bench.seed, before, values, weights);

    // Non-vacuity guard: at this seed and cursor the two weight vectors select
    // different values.
    expect(reversedPick).not.toBe(configuredPick);
    expect(resolved.value).toBe(reversedPick);
    expect(resolved.value).not.toBe(configuredPick);
  });

  it('starts from the ported vanilla distribution of js/game_manager.js L71',
    () => {
      expectSameNumbers(bench.config.spawn.values, VANILLA_SPAWN_VALUES);
      expectSameNumbers(bench.config.spawn.weights, VANILLA_SPAWN_WEIGHTS);
    });

  it('resolves to a value the live rules declare on every dispatch, never to '
    + 'one outside them', () => {
    for (let index = 0; index < DISPATCH_COUNT; index += 1) {
      const resolved = dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

      expect(bench.config.spawn.values).toContain(resolved.value);
    }
  });

  it('leaves the shared config spawn weights and values exactly as they '
    + 'arrived, reversing only a copy', () => {
    dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

    expectSameNumbers(bench.config.spawn.weights, VANILLA_SPAWN_WEIGHTS);
    expectSameNumbers(bench.config.spawn.values, VANILLA_SPAWN_VALUES);
  });

  it('leaves every other rule in force untouched', () => {
    const boardSize = bench.config.boardSize;
    const winValue = bench.config.winValue;
    const startTiles = bench.config.startTiles;
    const canMerge = bench.config.merge.canMerge;

    dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

    expect(bench.config.boardSize).toBe(boardSize);
    expect(bench.config.winValue).toBe(winValue);
    expect(bench.config.startTiles).toBe(startTiles);
    expect(bench.config.merge.canMerge).toBe(canMerge);
  });

  it('reads the rules in force, so a three-entry distribution installed '
    + 'between dispatches is the one reversed', () => {
    dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));
    installDistribution(bench, THREE_VALUE_SPAWN, THREE_VALUE_WEIGHTS);

    const before = bench.streams.snapshotCursors();
    const resolved = dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

    const reversedPick = parallelPick(
      bench.seed,
      before,
      THREE_VALUE_SPAWN,
      reversedWeights(THREE_VALUE_WEIGHTS),
    );
    const configuredPick = parallelPick(
      bench.seed,
      before,
      THREE_VALUE_SPAWN,
      THREE_VALUE_WEIGHTS,
    );

    expect(reversedPick).not.toBe(configuredPick);
    expect(resolved.value).toBe(reversedPick);
    expect(resolved.value).not.toBe(configuredPick);
    expect(THREE_VALUE_SPAWN).toContain(resolved.value);
  });

  it('reverses the whole weight vector rather than exchanging its two ends',
    () => {
      installDistribution(bench, FOUR_VALUE_SPAWN, THIRD_ENTRY_WEIGHTS);

      const before = bench.streams.snapshotCursors();
      const resolved = dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

      const reversedPick = parallelPick(
        bench.seed,
        before,
        FOUR_VALUE_SPAWN,
        reversedWeights(THIRD_ENTRY_WEIGHTS),
      );
      const endSwappedPick = parallelPick(
        bench.seed,
        before,
        FOUR_VALUE_SPAWN,
        endSwappedWeights(THIRD_ENTRY_WEIGHTS),
      );

      expect(reversedPick).not.toBe(endSwappedPick);
      expect(resolved.value).toBe(reversedPick);
      expect(resolved.value).not.toBe(endSwappedPick);
    });

  it('resolves to the one configured value when the distribution holds a '
    + 'single entry, a reversal that is the identity', () => {
    installDistribution(bench, SINGLE_VALUE_SPAWN, SINGLE_VALUE_WEIGHTS);

    const resolved = dispatch(bench, spawnAt(2, 3, INCOMING_VALUE));

    expect(resolved.value).toBe(SINGLE_VALUE_SPAWN[0]);
    expect(resolved.position).toEqual({ x: 2, y: 3 });
  });

  it('leaves the spawn as the rules produced it when the distribution holds '
    + 'no entry', () => {
    installDistribution(bench, [], []);

    const resolved = dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

    expect(resolved.value).toBe(INCOMING_VALUE);
  });

  it('leaves the spawn as the rules produced it when the two distribution '
    + 'arrays disagree in length', () => {
    installDistribution(bench, THREE_VALUE_SPAWN, SINGLE_VALUE_WEIGHTS);

    const resolved = dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

    expect(resolved.value).toBe(INCOMING_VALUE);
  });

  // The weight vectors below are ALIGNED with their values — same length, both
  // non-empty — and are still unusable, which is the second family of refusals
  // `totalWeightOf` of src/rng/rng-streams.ts applies: a total of zero, any
  // negative weight, any weight that is not finite, and a total that overflows
  // to infinity. Each is measured BEFORE a draw is taken, so a refusal costs no
  // randomness.
  for (const unusable of UNUSABLE_WEIGHT_VECTORS) {
    it(`leaves the spawn, the cursors and the rules alone for ${unusable.name}`,
      () => {
        installDistribution(bench, THREE_VALUE_SPAWN, unusable.weights);

        const before = bench.streams.snapshotCursors();
        const boardBefore = bench.grid.serialize();
        const payload = spawnAt(1, 2, INCOMING_VALUE);
        const resolved = dispatch(bench, payload);
        const after = bench.streams.snapshotCursors();

        // The payload is the one the rules produced, member for member.
        expect(resolved.value).toBe(INCOMING_VALUE);
        expect(resolved.position).toEqual({ x: 1, y: 2 });
        expect(resolved.count).toBe(payload.count);

        // No cursor moved — the draw substream included — so a refused
        // distribution cannot shift the sequence a seed reproduces.
        expect(after[DRAW_STREAM]).toBe(before[DRAW_STREAM]);
        expect(after[DRAW_STREAM]).toBe(0);
        expectUnmovedStreams(before, after);
        expect(after).toEqual(before);

        // And the refusal is the substream's, not a shape this relic rejected
        // first: the same vector refuses a direct weighted draw.
        expect(
          parallelPick(bench.seed, before, THREE_VALUE_SPAWN, unusable.weights),
        ).toBeUndefined();

        // Nothing else was written: not the rules, not the lattice, not the
        // relic's own slot, and no board command or charge was requested.
        expectSameNumbers(bench.config.spawn.values, THREE_VALUE_SPAWN);
        expect(bench.config.spawn.weights).toEqual([...unusable.weights]);
        expect(bench.config.boardSize).toBe(bench.grid.size);
        expect(bench.grid.serialize()).toEqual(boardBefore);
        expect(bench.context.state).toBeUndefined();
        expect(bench.commands).toEqual([]);
        expect(bench.chargeRequests).toEqual([]);
      });
  }

  it('takes the reversal of an unusable vector no further than the draw', () => {
    // The handler reverses the weights on a COPY before it draws, so a refused
    // draw leaves the configured vector in its original order rather than
    // reversed in place.
    const negative = [0.5, -0.2, 0.7];

    installDistribution(bench, THREE_VALUE_SPAWN, negative);

    expect(dispatch(bench, spawnAt(0, 0, INCOMING_VALUE)).value).toBe(
      INCOMING_VALUE,
    );
    expect(bench.config.spawn.weights).toEqual(negative);
  });
});

describe('loaded-dice biases the value alone', () => {
  it('keeps the cell and the tile count the engine resolved', () => {
    const resolved = dispatch(bench, spawnAt(3, 1, INCOMING_VALUE));

    expect(resolved.position).toEqual({ x: 3, y: 1 });
    expect(resolved.count).toBe(INCOMING_COUNT);
  });

  it('leaves an absent position absent on a board offering no cell, without '
    + 'throwing and without fabricating one', () => {
    const fullish = createBench({
      board: createNearLossBoard(),
      seed: PRIMARY_SEED,
    });

    const resolved = dispatch(fullish, spawnWithoutCell(INCOMING_VALUE));

    expect('position' in resolved).toBe(false);
    expect(resolved.position).toBeUndefined();
    expect(fullish.config.spawn.values).toContain(resolved.value);
  });

  it('does not write the payload it was handed', () => {
    const payload = spawnAt(1, 1, INCOMING_VALUE);
    const resolved = dispatch(bench, payload);

    expect(payload.value).toBe(INCOMING_VALUE);
    expect(payload.position).toEqual({ x: 1, y: 1 });
    expect(typeof resolved.value).toBe('number');
  });

  it('records no board command and requests no charge, so neither the board '
    + 'nor the score can move through it', () => {
    const boardBefore = bench.grid.serialize();

    dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

    expect(bench.commands).toEqual([]);
    expect(bench.chargeRequests).toEqual([]);
    expect(bench.grid.serialize()).toEqual(boardBefore);
    expect(bench.context.effects.length).toBe(0);
  });

  it('writes nothing into its own state slot', () => {
    dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

    expect(bench.context.state).toBeUndefined();
  });
});

describe('loaded-dice carries no charge budget', () => {
  it('omits the charges member from its declaration rather than declaring it '
    + 'null', () => {
    const relic = catalogueRelic();

    expect('charges' in relic).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(relic, 'charges')).toBe(false);
    expect(relic.charges).not.toBeNull();
    expect(relic.charges).toBeUndefined();
  });

  it('omits the state member from its declaration', () => {
    const relic = catalogueRelic();

    expect('state' in relic).toBe(false);
    expect(relic.state).toBeUndefined();
  });

  it('names no charge budget in its own source, the guard belonging to the '
    + 'bus', () => {
    expect(handlerSource()).not.toContain('charges');
    expect(handlerSource()).not.toContain('spendCharge');
  });

  it('requests no charge on any dispatch, whatever budget the subscription '
    + 'carries', () => {
    for (const charges of [undefined, 0, 3]) {
      const target = createBench({ charges });

      dispatch(target, spawnAt(0, 0, INCOMING_VALUE));

      expect(target.chargeRequests).toEqual([]);
      expect(target.context.charges).toBe(charges);
    }
  });

  it('resolves a spawn at zero charges without throwing, leaving the rules, '
    + 'the board and the state slot intact', () => {
    const exhausted = createBench({ charges: 0 });
    const boardBefore = exhausted.grid.serialize();

    const resolved = dispatch(exhausted, spawnAt(0, 0, INCOMING_VALUE));

    expect(exhausted.config.spawn.values).toContain(resolved.value);
    expectSameNumbers(exhausted.config.spawn.values, VANILLA_SPAWN_VALUES);
    expectSameNumbers(exhausted.config.spawn.weights, VANILLA_SPAWN_WEIGHTS);
    expect(exhausted.grid.serialize()).toEqual(boardBefore);
    expect(exhausted.context.state).toBeUndefined();
    expect(exhausted.commands).toEqual([]);
    expect(exhausted.chargeRequests).toEqual([]);
  });

  it('resolves ten consecutive spawns at zero charges without throwing', () => {
    const exhausted = createBench({ charges: 0 });

    for (let index = 0; index < DISPATCH_COUNT; index += 1) {
      const resolved = dispatch(exhausted, spawnAt(0, 0, INCOMING_VALUE));

      expect(exhausted.config.spawn.values).toContain(resolved.value);
    }

    expect(exhausted.chargeRequests).toEqual([]);
    expect(exhausted.commands).toEqual([]);
  });
});

describe('loaded-dice stays deterministic under a fixed seed', () => {
  it('resolves the identical ten-value sequence from two independently built '
    + 'substream sets on one seed', () => {
    const first = sequenceFrom(PRIMARY_SEED, DISPATCH_COUNT);
    const second = sequenceFrom(PRIMARY_SEED, DISPATCH_COUNT);

    expect(first.length).toBe(DISPATCH_COUNT);
    expectSameNumbers(second, first);
  });

  it('resolves a sequence differing in at least one position on a second '
    + 'seed, so the sequence is genuinely drawn', () => {
    const primary = sequenceFrom(PRIMARY_SEED, DISPATCH_COUNT);
    const alternate = sequenceFrom(ALTERNATE_SEED, DISPATCH_COUNT);

    expect(primary.length).toBe(DISPATCH_COUNT);
    expect(alternate.length).toBe(DISPATCH_COUNT);

    const differing = primary.filter(
      (value, index) => value !== alternate[index],
    );

    expect(differing.length).toBeGreaterThan(0);
  });

  it('reproduces the whole sequence from a cursor snapshot, so a resumed run '
    + 'continues it', () => {
    const resumable = createBench({ seed: PRIMARY_SEED });
    const values = [...resumable.config.spawn.values];
    const inverted = reversedWeights(resumable.config.spawn.weights);
    const expected: (number | undefined)[] = [];

    for (let index = 0; index < DISPATCH_COUNT; index += 1) {
      expected.push(
        parallelPick(
          resumable.seed,
          resumable.streams.snapshotCursors(),
          values,
          inverted,
        ),
      );

      const resolved = dispatch(resumable, spawnAt(0, 0, INCOMING_VALUE));

      expect(resolved.value).toBe(expected[index]);
    }

    expect(expected.length).toBe(DISPATCH_COUNT);
  });
});

describe('loaded-dice keeps every substream but its own standing still', () => {
  it('advances the relic-draw cursor by one per acting dispatch', () => {
    for (let index = 0; index < DISPATCH_COUNT; index += 1) {
      const before = bench.streams.snapshotCursors();

      dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

      const after = bench.streams.snapshotCursors();

      expect(after[DRAW_STREAM]).toBe(before[DRAW_STREAM] + 1);
    }

    expect(bench.streams.snapshotCursors()[DRAW_STREAM]).toBe(DISPATCH_COUNT);
  });

  it('leaves the two spawn substreams and the rarity-weight substream '
    + 'unmoved, so it can shift no engine spawn sequence', () => {
    const before = bench.streams.snapshotCursors();

    for (let index = 0; index < DISPATCH_COUNT; index += 1) {
      dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));
    }

    const after = bench.streams.snapshotCursors();

    expectUnmovedStreams(before, after);
    expect(UNMOVED_STREAMS.length).toBe(3);

    for (const name of UNMOVED_STREAMS) {
      expect(after[name]).toBe(0);
    }
  });

  it('advances no cursor at all on a distribution it cannot draw from', () => {
    installDistribution(bench, [], []);

    const before = bench.streams.snapshotCursors();

    dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

    const after = bench.streams.snapshotCursors();

    expect(after[DRAW_STREAM]).toBe(before[DRAW_STREAM]);
    expectUnmovedStreams(before, after);
  });

  it('advances no cursor at all when the two distribution arrays disagree in '
    + 'length', () => {
    installDistribution(bench, THREE_VALUE_SPAWN, SINGLE_VALUE_WEIGHTS);

    const before = bench.streams.snapshotCursors();

    dispatch(bench, spawnAt(0, 0, INCOMING_VALUE));

    const after = bench.streams.snapshotCursors();

    expect(after[DRAW_STREAM]).toBe(before[DRAW_STREAM]);
    expectUnmovedStreams(before, after);
  });

  it('names no Math.random, no console and no catch in its own source', () => {
    const source = handlerSource();

    expect(source).not.toContain('Math.random');
    expect(source).not.toContain('console');
    expect(source).not.toContain('catch');
    expect(source).toContain('reverse');
    expect(source).toContain('pickWeighted');
  });
});

describe('loaded-dice and the default rules survive the suite', () => {
  it('leaves the shared catalogue declaration frozen and identical to the '
    + 'object imported at module load', () => {
    const relic = catalogueRelic();

    expect(relic.id).toBe(DECLARATION_AT_IMPORT.id);
    expect(relic.name).toBe(DECLARATION_AT_IMPORT.name);
    expect(relic.rarity).toBe(DECLARATION_AT_IMPORT.rarity);
    expect(relic.description).toBe(DECLARATION_AT_IMPORT.description);
    expect(Object.keys(relic.hooks)).toEqual([
      ...DECLARATION_AT_IMPORT.hookKeys,
    ]);
    expect(relic.hooks.onSpawn).toBe(DECLARATION_AT_IMPORT.handler);
    expect(Object.isFrozen(relic)).toBe(true);
    expect(Object.isFrozen(relic.hooks)).toBe(true);
    expect(relic).toBe(familyRelic());
  });

  it('leaves a freshly built rules object carrying the ported vanilla spawn '
    + 'distribution', () => {
    const fresh = createDefaultRulesConfig();

    expectSameNumbers(fresh.spawn.values, VANILLA_SPAWN_VALUES);
    expectSameNumbers(fresh.spawn.weights, VANILLA_SPAWN_WEIGHTS);
  });

  it('leaves the bench rebuilt by the last setup untouched by earlier tests',
    () => {
      expectSameNumbers(bench.config.spawn.values, VANILLA_SPAWN_VALUES);
      expectSameNumbers(bench.config.spawn.weights, VANILLA_SPAWN_WEIGHTS);
      expect(bench.streams.snapshotCursors()[DRAW_STREAM]).toBe(0);
      expect(bench.commands).toEqual([]);
      expect(bench.chargeRequests).toEqual([]);
    });
});
