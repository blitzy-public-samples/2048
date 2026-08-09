// Per-relic suite for the `spawn-control` relic `twin-seed`, AAP 0.6.3 Group
// 5.
//
// Three properties, held by sections 4, 5 and 6 in turn: 1 the relic fires
// only on the hooks its declaration binds 2 the relic produces its specified
// effect 3 the relic respects `charges`, a zero-charge invocation included
//
// Decisions: DL-SPAWN-01, DL-SPAWN-02 (docs/DECISION_LOG.md).

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import type {
  MergePredicate,
  RulesConfig,
} from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  BoardEffect,
  BoardEffectQueue,
  BoardEffectRequest,
  HookContext,
  HookHandler,
  HookName,
  ReadonlyGridView,
  SpawnPayload,
} from '../../../src/engine/hooks';
import type {
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
import { createRngStreams } from '../../../src/rng/rng-streams';
import type { RngCursorMap, RngStreams } from '../../../src/rng/rng-streams';
import {
  createMergePairBoard,
  createNearLossBoard,
} from '../../fixtures/boards';

/** Identifier the declaration under test carries. */
const TWIN_SEED_ID = 'twin-seed';

/** The one hook name the declaration binds. */
const BOUND_HOOK: HookName = 'onSpawn';

/**
 * Run seed whose first eight `relic-draw` draws all fall below the relic's
 * promotion threshold, so every eligible spawn dispatched under it is
 * promoted.
 */
const PROMOTING_SEED = 'twin-seed-1';

/**
 * Run seed whose first seven `relic-draw` draws all sit at or above that
 * threshold, so every eligible spawn dispatched under it is left as it
 * arrived.
 */
const DECLINING_SEED = 'twin-seed-2';

/** Promotions `PROMOTING_SEED` yields in a row from a fresh stream set. */
const PROMOTING_RUN_LENGTH = 8;

/** Declines `DECLINING_SEED` yields in a row from a fresh stream set. */
const DECLINING_RUN_LENGTH = 7;

/** Correlation identifier every context below carries. */
const RUN_CORRELATION_ID = 'run-twin-seed-suite';

/** Cursor map of a run that has taken no draw from any substream. */
const NO_DRAWS: RngCursorMap = {
  'spawn-value': 0,
  'spawn-position': 0,
  'relic-draw': 0,
  'rarity-weight': 0,
};

/** Cursor map of a run whose only draw came from `relic-draw`. */
const ONE_RELIC_DRAW: RngCursorMap = { ...NO_DRAWS, 'relic-draw': 1 };

/**
 * Reads the declaration under test from the family export.
 *
 * @returns The `twin-seed` declaration.
 * @throws {Error} If the family declares no relic under that identifier, so
 *   a rename fails here instead of as a member access on `undefined` later.
 */
function twinSeed(): Relic {
  const found = SPAWN_CONTROL_FAMILY.relics.find(
    (relic) => relic.id === TWIN_SEED_ID,
  );

  if (found === undefined) {
    throw new Error(
      'The spawn-control family declares no relic with the identifier ' +
        `"${TWIN_SEED_ID}"; this suite dispatches that declaration.`,
    );
  }

  return found;
}

/**
 * Reads the handler the declaration binds to `onSpawn`.
 *
 * @returns The bound handler.
 * @throws {Error} If the declaration binds nothing to that hook.
 */
function onSpawnHandler(): HookHandler<'onSpawn'> {
  const handler = twinSeed().hooks.onSpawn;

  if (handler === undefined) {
    throw new Error(
      `The "${TWIN_SEED_ID}" declaration binds no onSpawn handler.`,
    );
  }

  return handler;
}

/**
 * Wraps a live board in the query surface a handler is handed.
 *
 * @param grid Board the view reads.
 * @returns The query surface.
 */
function readonlyGridView(grid: Grid): ReadonlyGridView {
  return {
    get size(): number {
      return grid.size;
    },

    withinBounds: (position: Position): boolean =>
      grid.withinBounds(position),
    cellAvailable: (cell: Position): boolean => grid.cellAvailable(cell),
    cellOccupied: (cell: Position): boolean => grid.cellOccupied(cell),
    cellValue: (cell: Position): number | null =>
      grid.cellContent(cell)?.value ?? null,
    availableCells: (): Position[] => grid.availableCells(),
    cellsAvailable: (): boolean => grid.cellsAvailable(),
    serialize: (): SerializedGrid => grid.serialize(),
  };
}

/**
 * @param view Query surface the read members answer from.
 * @returns The recording channel.
 */
function recordingEffectQueue(view: ReadonlyGridView): BoardEffectQueue {
  const recorded: BoardEffect[] = [];
  let refused = 0;

  const record = (effect: BoardEffect): boolean => {
    recorded.push(effect);

    return true;
  };

  const refuse = (): boolean => {
    refused += 1;

    return false;
  };

  return {
    get size(): number {
      return view.size;
    },

    get length(): number {
      return recorded.length;
    },

    get refused(): number {
      return refused;
    },

    insertTile: (cell: Position, value: number): boolean =>
      record({ kind: 'insertTile', cell, value }),
    removeTile: (cell: Position): boolean =>
      record({ kind: 'removeTile', cell }),
    moveTile: (from: Position, to: Position, tween = true): boolean =>
      record({ kind: 'moveTile', from, to, tween }),
    restoreBoard: (snapshot: SerializedGrid, score?: number): boolean =>
      record({ kind: 'restoreBoard', snapshot, score }),
    resizeBoard: (size: number): boolean =>
      record({ kind: 'resizeBoard', size }),
    setMergePredicate: (predicate: MergePredicate): boolean =>
      record({ kind: 'setMergePredicate', predicate }),
    setSpawnWeights: (weights: readonly number[]): boolean =>
      record({ kind: 'setSpawnWeights', weights }),

    request: (effect: BoardEffectRequest): boolean => {
      if (effect.kind === 'restoreBoard') {
        const snapshot = effect.snapshot ?? effect.board;

        return snapshot === undefined
          ? refuse()
          : record({ kind: 'restoreBoard', snapshot, score: effect.score });
      }

      if (effect.kind === 'resizeBoard') {
        const size = effect.size ?? effect.boardSize;

        return size === undefined
          ? refuse()
          : record({ kind: 'resizeBoard', size });
      }

      if (effect.kind === 'moveTile') {
        return record({
          kind: 'moveTile',
          from: effect.from,
          to: effect.to,
          tween: effect.tween ?? true,
        });
      }

      return record(effect);
    },

    requested: (): readonly BoardEffect[] => Object.freeze(recorded.slice()),
    cellValue: (cell: Position): number | null => view.cellValue(cell),
    cellOccupied: (cell: Position): boolean => view.cellOccupied(cell),
    availableCells: (): Position[] => view.availableCells(),

    occupiedCells: (): readonly { x: number; y: number; value: number }[] => {
      const cells: { x: number; y: number; value: number }[] = [];

      for (let x = 0; x < view.size; x += 1) {
        for (let y = 0; y < view.size; y += 1) {
          const value = view.cellValue({ x, y });

          if (value !== null) {
            cells.push({ x, y, value });
          }
        }
      }

      return Object.freeze(cells);
    },

    clear: (): void => {
      recorded.length = 0;
    },
  };
}

/** One assembled dispatch: the collaborators a test reads, and the context. */
interface Bench {
  /**
   * The rules in force, as `createDefaultRulesConfig` returns them: a fresh
   * mutable object, never the deep-frozen `DEFAULT_RULES_CONFIG` template. The
   * context below carries THIS object, so a test that writes a rule here
   * changes the rules the next dispatch reads.
   */
  readonly config: RulesConfig;

  /** The live board the context's query surface reads. */
  readonly grid: Grid;

  /** The run's four named substreams, seeded from a fixed literal. */
  readonly streams: RngStreams;

  /** The board-write channel, read by the tests that assert none was used. */
  readonly effects: BoardEffectQueue;

  /** Amounts passed to `spendCharge`, in call order. */
  readonly chargeRequests: number[];

  /** The context a handler is invoked with. */
  readonly context: HookContext;
}

/** What a test varies from one assembled dispatch to the next. */
interface BenchOptions {
  /** Run seed. Defaults to `PROMOTING_SEED`. */
  readonly seed?: string;

  /** Board to build the lattice from. Defaults to the merge-pair fixture. */
  readonly board?: SerializedGameState;

  /** Charge budget the notional subscription carries. Absent by default. */
  readonly charges?: number | undefined;

  /** Initial value of the subscriber's own state slot. */
  readonly state?: unknown;
}

/**
 * Assembles one dispatch: fresh rules, a fresh lattice, a fresh stream set and
 * a context carrying all three plus the run correlation identifier.
 *
 * @param options What to vary from the defaults.
 * @returns The assembled dispatch.
 */
function createBench(options: BenchOptions = {}): Bench {
  const board = options.board ?? createMergePairBoard();
  const config = createDefaultRulesConfig();
  const grid = new Grid(board.grid.size, board.grid.cells);
  const view = readonlyGridView(grid);
  const effects = recordingEffectQueue(view);
  const streams = createRngStreams(options.seed ?? PROMOTING_SEED);
  const chargeRequests: number[] = [];

  return {
    config,
    grid,
    streams,
    effects,
    chargeRequests,

    context: {
      config,
      rng: streams,
      grid: view,
      effects,
      correlationId: RUN_CORRELATION_ID,
      hook: BOUND_HOOK,
      subscriberId: TWIN_SEED_ID,
      pickupOrder: 0,
      charges: options.charges,

      spendCharge: (amount?: number): boolean => {
        chargeRequests.push(amount ?? 1);

        return false;
      },

      state: options.state,
    },
  };
}

/**
 * @param value Face value the rules produced.
 * @param position Cell the engine resolved, or omitted for none.
 * @param count Tiles the spawn inserts, or omitted for the engine's own.
 * @returns The frozen payload.
 */
function spawnPayload(
  value: number,
  position?: Position,
  count?: number,
): SpawnPayload {
  const payload: { position?: Position; value: number; count?: number } = {
    value,
  };

  if (position !== undefined) {
    payload.position = Object.freeze({ ...position });
  }

  if (count !== undefined) {
    payload.count = count;
  }

  return Object.freeze(payload);
}

/**
 * Invokes the bound handler and requires that it answered with a payload.
 *
 * @param target Assembled dispatch to invoke against.
 * @param payload Spawn payload the engine would have carried.
 * @returns The payload the handler resolved to.
 * @throws {Error} If the handler answered with nothing.
 */
function dispatch(target: Bench, payload: SpawnPayload): SpawnPayload {
  const returned = onSpawnHandler()(payload, target.context);

  if (returned === undefined) {
    throw new Error(
      `The "${TWIN_SEED_ID}" onSpawn handler answered with no payload; it ` +
        'transforms the spawn it is given and returns it.',
    );
  }

  return returned;
}

/**
 * The bound handler as read once at collection, compared again in section 8 so
 * a binding replaced during the run is caught.
 */
const HANDLER_AT_COLLECTION: HookHandler<'onSpawn'> = onSpawnHandler();

/** The rule members a spawn handler can reach, read for comparison. */
interface RulesReading {
  readonly boardSize: number;
  readonly winValue: number;
  readonly startTiles: number;
  readonly values: readonly number[];
  readonly weights: readonly number[];
}

/**
 * Reads the rules in force into a detached value.
 *
 * @param config Rules to read.
 * @returns A fresh reading, sharing no array with `config`.
 */
function readRules(config: RulesConfig): RulesReading {
  return {
    boardSize: config.boardSize,
    winValue: config.winValue,
    startTiles: config.startTiles,
    values: [...config.spawn.values],
    weights: [...config.spawn.weights],
  };
}

/** The assembled dispatch every test that varies nothing works against. */
let bench: Bench;

beforeEach(() => {
  bench = createBench();
});

describe('twin-seed, the declaration this suite dispatches', () => {
  it('is the spawn-control entry the catalogue publishes by id', () => {
    const relic = twinSeed();

    expect(relic.id).toBe(TWIN_SEED_ID);
    expect(findRelicById(TWIN_SEED_ID)).toBe(relic);
    expect(RARITIES).toContain(relic.rarity);
    expect(relic.name).toBe('Twin Seed');
    expect(relic.description.length).toBeGreaterThan(0);
  });
});

describe('twin-seed fires only on the hooks its declaration binds', () => {
  it('binds onSpawn, and binds it to a function', () => {
    const { hooks } = twinSeed();

    expect(Object.keys(hooks)).toEqual([BOUND_HOOK]);
    expect(typeof hooks.onSpawn).toBe('function');
  });

  it('binds no other hook name, absent rather than undefined', () => {
    const { hooks } = twinSeed();
    const unbound = HOOK_NAMES.filter((name) => name !== BOUND_HOOK);

    // Five of the six names `HOOK_NAMES` declares.
    expect(unbound).toHaveLength(5);

    for (const name of unbound) {
      expect(Object.hasOwn(hooks, name)).toBe(false);
      expect(name in hooks).toBe(false);
      expect(hooks[name]).toBeUndefined();
    }
  });

  it('binds only names the engine dispatches', () => {
    for (const name of Object.keys(twinSeed().hooks)) {
      expect(HOOK_NAMES).toContain(name);
    }
  });
});

describe('twin-seed promotes a lowest-value spawn up the live ladder', () => {
  it('promotes the lowest configured value to the next one above it', () => {
    // The ported vanilla distribution, js/game_manager.js L71.
    expect(bench.config.spawn.values).toEqual([2, 4]);
    expect(bench.config.spawn.weights).toEqual([0.9, 0.1]);

    // What the dispatch carries besides the payload: the run correlation
    // identifier of src/engine/types.ts and the hook being dispatched.
    expect(bench.context.correlationId).toBe(RUN_CORRELATION_ID);
    expect(bench.context.hook).toBe(BOUND_HOOK);

    const payload = spawnPayload(2, { x: 2, y: 2 });
    const result = dispatch(bench, payload);

    // `HookHandler` of src/engine/hooks.ts admits either a payload or nothing;
    // this handler answers with a PAYLOAD.
    expect(result).toEqual({ position: { x: 2, y: 2 }, value: 4 });
    expect(typeof result).toBe('object');

    // The payload it was given is left as it arrived.
    expect(payload.value).toBe(2);
  });

  it('leaves a value at the top of the ladder as it arrived', () => {
    const payload = spawnPayload(4, { x: 1, y: 1 });
    const result = dispatch(bench, payload);

    // No value above the top: the ladder is not run off its end.
    expect(result).toBe(payload);
    expect(result.value).toBe(4);
    expect(bench.config.spawn.values).toContain(result.value);
    expect(Number.isNaN(result.value)).toBe(false);
  });

  it('leaves a value absent from the ladder as it arrived', () => {
    const payload = spawnPayload(8, { x: 0, y: 0 });
    const result = dispatch(bench, payload);

    expect(bench.config.spawn.values).not.toContain(8);
    expect(result).toBe(payload);
    expect(result.value).toBe(8);
    expect(Number.isInteger(result.value)).toBe(true);
  });

  it('promotes one step up a three-value ladder, not to its top', () => {
    bench.config.spawn.values = [2, 4, 8];
    bench.config.spawn.weights = [0.8, 0.15, 0.05];

    // 4 is one step above the lowest value; 8 is the top of the ladder.
    expect(dispatch(bench, spawnPayload(2, { x: 3, y: 0 })).value).toBe(4);
  });

  it('follows the ladder in force after the rules are changed', () => {
    bench.config.spawn.values = [8, 16, 32];
    bench.config.spawn.weights = [0.8, 0.15, 0.05];

    expect(dispatch(bench, spawnPayload(8, { x: 0, y: 2 })).value).toBe(16);
    expect(dispatch(bench, spawnPayload(2, { x: 0, y: 2 })).value).toBe(2);
  });

  it('reads the ladder in ascending order, however it is declared', () => {
    bench.config.spawn.values = [4, 2];
    bench.config.spawn.weights = [0.1, 0.9];

    expect(dispatch(bench, spawnPayload(2, { x: 1, y: 2 })).value).toBe(4);
    expect(dispatch(bench, spawnPayload(4, { x: 1, y: 2 })).value).toBe(4);
  });

  it('leaves the spawn alone when the ladder declares one value', () => {
    bench.config.spawn.values = [2];
    bench.config.spawn.weights = [1];

    const payload = spawnPayload(2, { x: 2, y: 1 });
    const result = dispatch(bench, payload);

    // No value above the only one: nothing to promote to.
    expect(result).toBe(payload);
    expect(result.value).toBe(2);
  });

  it('carries position and count through the promotion', () => {
    const payload = spawnPayload(2, { x: 1, y: 3 }, 2);
    const result = dispatch(bench, payload);

    expect(result).toEqual({ position: { x: 1, y: 3 }, value: 4, count: 2 });

    // The promoted payload is a fresh object carrying the SAME position.
    expect(result).not.toBe(payload);
    expect(result.position).toBe(payload.position);
    expect(result.count).toBe(2);
    expect(Object.keys(result).sort()).toEqual(['count', 'position', 'value']);
  });

  it('promotes a spawn carrying no position, leaving none', () => {
    const full = createBench({
      seed: PROMOTING_SEED,
      board: createNearLossBoard(),
    });

    expect(full.grid.cellsAvailable()).toBe(false);

    const result = dispatch(full, spawnPayload(2));

    expect(result.value).toBe(4);
    expect(Object.hasOwn(result, 'position')).toBe(false);
    expect(result.position).toBeUndefined();
  });

  it('leaves the board as it arrived and records no board effect', () => {
    const before = bench.grid.serialize();
    const result = dispatch(bench, spawnPayload(2, { x: 2, y: 3 }));

    expect(bench.grid.serialize()).toEqual(before);

    // A score reaches a run only through a `restoreBoard` command of
    // src/engine/board-effects.ts: the channel is empty and the resolved
    // payload declares no score member.
    expect(bench.effects.requested()).toEqual([]);
    expect(bench.effects.length).toBe(0);
    expect(bench.effects.refused).toBe(0);
    expect(Object.hasOwn(result, 'score')).toBe(false);
  });

  it('leaves the rules as they arrived', () => {
    const { canMerge, produce } = bench.config.merge;
    const before = readRules(bench.config);

    dispatch(bench, spawnPayload(2, { x: 0, y: 1 }));

    expect(readRules(bench.config)).toEqual(before);
    expect(bench.config.merge.canMerge).toBe(canMerge);
    expect(bench.config.merge.produce).toBe(produce);
    expect(bench.config.boardSize).toBe(DEFAULT_BOARD_SIZE);
  });

  it('returns the payload it was given when the draw declines', () => {
    const declining = createBench({ seed: DECLINING_SEED });
    const payload = spawnPayload(2, { x: 3, y: 3 });
    const result = dispatch(declining, payload);

    expect(result).toBe(payload);
    expect(result.value).toBe(2);

    // The draw was taken and then declined, so it is accounted for.
    expect(declining.streams.snapshotCursors()).toEqual(ONE_RELIC_DRAW);
  });
});

describe('twin-seed carries no charge budget and never reads one', () => {
  it('declares no charges member at all', () => {
    const relic = twinSeed();

    expect(Object.hasOwn(relic, 'charges')).toBe(false);
    expect('charges' in relic).toBe(false);
    expect(relic.charges).toBeUndefined();
    expect(relic.charges).not.toBeNull();
  });

  it('consults no budget, traps no error and calls no console', () => {
    const source = onSpawnHandler().toString();

    expect(source).not.toContain('charges');
    expect(source).not.toContain('catch');
    expect(source).not.toContain('console');

    // Two fragments of the handler's own body: the string read above is that
    // body, not a native-code stub.
    expect(source).toContain('config.spawn.values');
    expect(source).toContain('rng.stream(');
  });

  it('promotes on a zero budget without asking for a charge', () => {
    const exhausted = createBench({ seed: PROMOTING_SEED, charges: 0 });

    expect(exhausted.context.charges).toBe(0);
    expect(dispatch(exhausted, spawnPayload(2, { x: 1, y: 1 })).value).toBe(4);
    expect(exhausted.chargeRequests).toEqual([]);
  });

  it('leaves the state slot and the rules intact on a zero budget', () => {
    const slot = { carried: 1 };
    const exhausted = createBench({
      seed: PROMOTING_SEED,
      charges: 0,
      state: slot,
    });
    const before = readRules(exhausted.config);
    const lattice = exhausted.grid.serialize();

    dispatch(exhausted, spawnPayload(2, { x: 0, y: 3 }));

    expect(exhausted.context.state).toBe(slot);
    expect(exhausted.context.state).toEqual({ carried: 1 });
    expect(readRules(exhausted.config)).toEqual(before);
    expect(exhausted.grid.serialize()).toEqual(lattice);
    expect(exhausted.effects.requested()).toEqual([]);
  });
});

describe('twin-seed draws only from the relic-draw substream', () => {
  it('advances the relic-draw cursor by one and no other cursor', () => {
    expect(bench.streams.snapshotCursors()).toEqual(NO_DRAWS);
    expect(dispatch(bench, spawnPayload(2, { x: 2, y: 3 })).value).toBe(4);

    const after = bench.streams.snapshotCursors();

    // A pure value promotion moves neither spawn substream, so it cannot shift
    // the cell or the value the engine's own draws resolve to.
    expect(after['spawn-position']).toBe(0);
    expect(after['spawn-value']).toBe(0);
    expect(after['rarity-weight']).toBe(0);
    expect(after['relic-draw']).toBe(1);
    expect(after).toEqual(ONE_RELIC_DRAW);
  });

  it('takes no draw for a spawn it cannot act on', () => {
    expect(dispatch(bench, spawnPayload(4, { x: 1, y: 2 })).value).toBe(4);
    expect(bench.streams.snapshotCursors()).toEqual(NO_DRAWS);

    bench.config.spawn.values = [2];
    bench.config.spawn.weights = [1];

    expect(dispatch(bench, spawnPayload(2, { x: 1, y: 2 })).value).toBe(2);
    expect(bench.streams.snapshotCursors()).toEqual(NO_DRAWS);
  });

  it('agrees with a second stream set built from the same seed', () => {
    const first = createBench({ seed: PROMOTING_SEED });
    const second = createBench({ seed: PROMOTING_SEED });
    const payload = spawnPayload(2, { x: 1, y: 1 });

    expect(dispatch(first, payload)).toEqual(dispatch(second, payload));
    expect(first.streams.snapshotCursors()).toEqual(
      second.streams.snapshotCursors(),
    );
    expect(first.streams.seed).toBe(second.streams.seed);
  });

  it('promotes eight in a row, and declines seven, by seed', () => {
    const promoting = createBench({ seed: PROMOTING_SEED });
    const declining = createBench({ seed: DECLINING_SEED });
    const promoted: number[] = [];
    const declined: number[] = [];

    for (let index = 0; index < PROMOTING_RUN_LENGTH; index += 1) {
      promoted.push(dispatch(promoting, spawnPayload(2)).value);
    }

    for (let index = 0; index < DECLINING_RUN_LENGTH; index += 1) {
      declined.push(dispatch(declining, spawnPayload(2)).value);
    }

    // Both branches of the relic's coin flip are exercised by the two seeds
    // the sections above dispatch under, so neither branch is dead.
    expect(promoted).toHaveLength(PROMOTING_RUN_LENGTH);
    expect(declined).toHaveLength(DECLINING_RUN_LENGTH);
    expect(promoted).toEqual([4, 4, 4, 4, 4, 4, 4, 4]);
    expect(declined).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(promoting.streams.snapshotCursors()['relic-draw']).toBe(
      PROMOTING_RUN_LENGTH,
    );
    expect(declining.streams.snapshotCursors()['relic-draw']).toBe(
      DECLINING_RUN_LENGTH,
    );
  });
});

describe('the twin-seed declaration is unchanged by this suite', () => {
  it('is still frozen, still binds onSpawn alone, still uncharged', () => {
    const relic = twinSeed();

    expect(Object.isFrozen(relic)).toBe(true);
    expect(Object.isFrozen(relic.hooks)).toBe(true);
    expect(Object.keys(relic.hooks)).toEqual([BOUND_HOOK]);
    expect(Object.hasOwn(relic, 'charges')).toBe(false);
    expect(relic.hooks.onSpawn).toBe(HANDLER_AT_COLLECTION);
    expect(findRelicById(TWIN_SEED_ID)).toBe(relic);
  });

  it('leaves the shared rules factory and board fixture pristine', () => {
    // Several tests above write `spawn.values` on their own configuration, and
    // every grid above is built from a fixture call.
    const fresh = createDefaultRulesConfig();
    const board = createMergePairBoard();
    const occupied = board.grid.cells.flat().filter((cell) => cell !== null);

    expect(fresh.spawn.values).toEqual([2, 4]);
    expect(fresh.spawn.weights).toEqual([0.9, 0.1]);
    expect(fresh.boardSize).toBe(DEFAULT_BOARD_SIZE);
    expect(occupied).toHaveLength(2);
    expect(occupied.map((cell) => cell?.value)).toEqual([2, 2]);
  });
});
