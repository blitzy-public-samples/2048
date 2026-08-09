// The `echo-chamber` relic of the `merge-magic` family, in isolation.
//
// The three properties AAP 0.6.3 Group 5 requires of every relic, asserted
// against the declaration src/relics/families/merge-magic.ts exports:
//   1. it fires only on the hooks it binds;
//   2. it produces its specified effect — a bonus fraction of `resultValue`
//      added to `scoreDelta`, with `resultValue` left as it arrived;
//   3. it respects a charge budget, an invocation at zero charges included.
//
// The handler is invoked DIRECTLY, over a `HookContext` assembled below, so
// what is measured here is the relic. src/engine/hook-bus.ts owns the charge
// guard, the pickup-order fan-out and the error isolation, and the suites
// under tests/unit/engine/ own those mechanisms.
//
// PROVENANCE OF THE PAYLOAD NUMBERS — the vanilla merge branch,
// js/game_manager.js L156-L170:
//   L156  `next && next.value === tile.value && !next.mergedFrom`
//         -> `config.merge.canMerge`, which accepts the value-2 pair used
//            throughout this file.
//   L157  `new Tile(positions.next, tile.value * 2)`
//         -> `config.merge.produce`, whose return the payload carries as
//            `resultValue`.
//   L167  `self.score += merged.value`
//         -> the payload's `scoreDelta`, which L167 held EQUAL to the produced
//            value. Every case below therefore enters with
//            `scoreDelta === resultValue`, and the separation of those two
//            members is what this suite measures.
//   L170  `merged.value === 2048`
//         -> `config.winValue`, which reads `resultValue` and not the score.
// js/tile.js L2-L4 flattens a position onto `x` and `y` and coerces a falsy
// value to 2, which is the shape the tiles below are constructed in.
//
// FIGURES THESE ASSERTIONS ARE THE MECHANICAL INSTANCE OF: Figure 5, "Hook
// Dispatch Sequence: Pickup-Order Fan-Out with Charge Guard and Error
// Isolation", of docs/architecture/hook-dispatch-sequence.md, whose
// transformed-payload return path is this handler; and Figure 4, "Turn Data
// Flow: From Keystroke to Composited Frame and Persisted Run State", of
// docs/architecture/data-flow.md, whose `onMerge dispatch, score delta
// applied` node is the step under test.
//
// Rows of docs/TRACEABILITY_MATRIX.md this suite is evidence for: TR-MERGE-01,
// the `echo-chamber` declaration; and TR-HOOK-03, js/game_manager.js
// L156-L170 mapped onto the `onMerge` payload members `resultValue` and
// `scoreDelta`.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md, entries
// DL-MERGE-01 and DL-MERGE-02.
//
// This suite reads no DOM and no storage, performs no I/O, reads no clock and
// takes no unseeded randomness: the only randomness reachable from the context
// is the four substreams derived from the fixed seed below.

import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { Grid } from '../../../src/engine/grid';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  BoardEffectQueue,
  HookContext,
  HookHandler,
  MergePayload,
  ReadonlyGridView,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import type { CorrelationId, Position } from '../../../src/engine/types';
import { MERGE_MAGIC_FAMILY } from '../../../src/relics/families/merge-magic';
import { findRelicById } from '../../../src/relics/relic-registry';
import { RARITIES } from '../../../src/relics/relic-types';
import type { Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type { RngStreams } from '../../../src/rng/rng-streams';
import { createMergePairBoard } from '../../fixtures/boards';

/* ==========================================================================
 * 1. The declaration under test
 * ========================================================================== */

/** Identifier the family declares the relic under. */
const RELIC_ID = 'echo-chamber';

/** Seed every substream in this file is derived from. */
const RUN_SEED = 'blitzy-echo-chamber';

/** Correlation identifier the dispatch context carries. */
const RUN_CORRELATION_ID: CorrelationId = 'run-blitzy-echo-chamber';

/**
 * Fraction of `resultValue` the relic adds to the score.
 *
 * The value src/relics/families/merge-magic.ts declares as the module-private
 * `ECHO_CHAMBER_SCORE_BONUS`, and the quarter the relic's own `description`
 * states. It is asserted against that description below, so the two cannot
 * drift apart unnoticed.
 */
const SCORE_BONUS_FRACTION = 0.25;

/** Every hook name, as a set, for the membership tests below. */
const HOOK_NAME_SET: ReadonlySet<string> = new Set(HOOK_NAMES);

/**
 * Reads the declaration out of the family that declares it.
 *
 * @returns The `echo-chamber` declaration.
 * @throws {Error} If the family declares no relic of that identifier, which
 *   fails this file at collection rather than silently skipping every
 *   assertion below.
 */
function readDeclaration(): Relic {
  const found = MERGE_MAGIC_FAMILY.relics.find(
    (candidate) => candidate.id === RELIC_ID,
  );

  if (found === undefined) {
    throw new Error(`The merge-magic family declares no ${RELIC_ID} relic.`);
  }

  return found;
}

/**
 * Reads the one handler the declaration binds.
 *
 * @param relic Declaration to read.
 * @returns The `onMerge` handler.
 * @throws {Error} If the declaration binds no `onMerge` handler.
 */
function readOnMergeHandler(relic: Relic): HookHandler<'onMerge'> {
  const bound = relic.hooks.onMerge;

  if (bound === undefined) {
    throw new Error(`The ${RELIC_ID} relic binds no onMerge handler.`);
  }

  return bound;
}

/** The declaration under test. */
const DECLARATION: Relic = readDeclaration();

/** The handler under test. */
const ON_MERGE: HookHandler<'onMerge'> = readOnMergeHandler(DECLARATION);

/** The handler's source text, read once for the assertions over it. */
const HANDLER_SOURCE: string = ON_MERGE.toString();

/** The members of a declaration this file compares before and after. */
interface Projection {
  readonly id: string;
  readonly name: string;
  readonly rarity: string;
  readonly description: string;
  readonly hooks: readonly string[];
  readonly declaresCharges: boolean;
  readonly declaresState: boolean;
}

/**
 * Projects the members of a declaration.
 *
 * @param relic Declaration to project.
 * @returns Its identifiers, its bound hook names and whether it declares a
 *   charge budget or a state slot.
 */
function project(relic: Relic): Projection {
  return {
    id: relic.id,
    name: relic.name,
    rarity: relic.rarity,
    description: relic.description,
    hooks: Object.keys(relic.hooks),
    declaresCharges: 'charges' in relic,
    declaresState: 'state' in relic,
  };
}

/** The declaration as it stood when this file was loaded. */
const AT_LOAD: Projection = project(DECLARATION);

/* ==========================================================================
 * 2. The dispatch context, assembled by hand
 * ========================================================================== */

/** One board-effect channel and the append-only log of every use of it. */
interface EffectWitness {
  readonly queue: BoardEffectQueue;

  /** Every member invocation, in call order, that `clear()` cannot erase. */
  readonly uses: readonly string[];
}

/**
 * Lists the occupied cells of a board with their values, x-outer and y-inner.
 *
 * @param grid Board to read.
 * @returns A fresh array of fresh records.
 */
function occupiedCellsOf(
  grid: Grid,
): { x: number; y: number; value: number }[] {
  const occupied: { x: number; y: number; value: number }[] = [];

  grid.eachCell((x, y, tile) => {
    if (tile) {
      occupied.push({ x, y, value: tile.value });
    }
  });

  return occupied;
}

/**
 * Opens a board-effect channel over a live board.
 *
 * Every write member records its own name and answers `true`; every query
 * member answers from the live board, so a handler reaching for one is
 * answered rather than met with a throw. `uses` records every invocation,
 * `clear()` included, and `length` reports the commands `clear()` discards.
 * `requested()` answers the empty list; `uses` is the record this file asserts
 * over, and no command can be erased from it.
 *
 * @param grid Board the queries resolve against.
 * @returns The channel and its use log.
 */
function openEffectWitness(grid: Grid): EffectWitness {
  const uses: string[] = [];
  const commands: string[] = [];

  const record = (command: string): boolean => {
    uses.push(command);
    commands.push(command);

    return true;
  };

  const queue: BoardEffectQueue = {
    get size(): number {
      return grid.size;
    },

    get length(): number {
      return commands.length;
    },

    refused: 0,
    insertTile: (): boolean => record('insertTile'),
    removeTile: (): boolean => record('removeTile'),
    moveTile: (): boolean => record('moveTile'),
    restoreBoard: (): boolean => record('restoreBoard'),
    resizeBoard: (): boolean => record('resizeBoard'),
    setMergePredicate: (): boolean => record('setMergePredicate'),
    setSpawnWeights: (): boolean => record('setSpawnWeights'),
    request: (): boolean => record('request'),
    requested: () => [],
    cellValue: (cell: Position) => grid.cellContent(cell)?.value ?? null,
    cellOccupied: (cell: Position) => grid.cellOccupied(cell),
    availableCells: () => grid.availableCells(),
    occupiedCells: () => occupiedCellsOf(grid),

    clear: (): void => {
      uses.push('clear');
      commands.length = 0;
    },
  };

  return { queue, uses };
}

/**
 * Builds the read-only board view a context carries.
 *
 * Every member reads the live board at call time. `cellValue` stands in for
 * `Grid.cellContent`, answering the face value rather than the tile.
 *
 * @param grid Live board to project.
 * @returns The query surface of that board.
 */
function readonlyGridView(grid: Grid): ReadonlyGridView {
  return {
    get size(): number {
      return grid.size;
    },

    withinBounds: (position: Position) => grid.withinBounds(position),
    cellAvailable: (cell: Position) => grid.cellAvailable(cell),
    cellOccupied: (cell: Position) => grid.cellOccupied(cell),
    cellValue: (cell: Position) => grid.cellContent(cell)?.value ?? null,
    availableCells: () => grid.availableCells(),
    cellsAvailable: () => grid.cellsAvailable(),
    serialize: () => grid.serialize(),
  };
}

/** The collaborators one dispatch of the handler is made over. */
interface Bench {
  /** The live, unfrozen rules, from `createDefaultRulesConfig()`. */
  readonly config: RulesConfig;

  /** The live board the context's view projects. */
  readonly grid: Grid;

  /** The run's four named substreams. */
  readonly streams: RngStreams;

  /** The context handed to the handler. */
  readonly context: HookContext;

  /** Every board-effect member the handler reached for. */
  readonly effectUses: readonly string[];

  /** Every charge amount the handler asked for, in call order. */
  readonly chargeRequests: readonly number[];

  /** The value seeded into the context's state slot. */
  readonly stateSlot: Record<string, unknown>;
}

/**
 * Assembles one bench: a fresh rules object, a fresh board from the
 * `merge-pair` fixture, the run's substreams, and the context over them.
 *
 * @param charges Charge budget the notional subscription carries. Omitted, the
 *   context carries none, which is what the declaration under test declares.
 * @returns The collaborators and the context.
 */
function createBench(charges?: number): Bench {
  const config = createDefaultRulesConfig();
  const board = createMergePairBoard();
  const grid = new Grid(board.grid.size, board.grid.cells);
  const streams = createRngStreams(RUN_SEED);
  const witness = openEffectWitness(grid);
  const chargeRequests: number[] = [];
  const stateSlot: Record<string, unknown> = { untouched: true };

  const context: HookContext = {
    config,
    rng: streams,
    grid: readonlyGridView(grid),
    effects: witness.queue,
    correlationId: RUN_CORRELATION_ID,
    hook: 'onMerge',
    subscriberId: RELIC_ID,
    pickupOrder: 0,
    charges,

    spendCharge: (amount?: number): boolean => {
      chargeRequests.push(amount ?? 1);

      return false;
    },

    state: stateSlot,
  };

  return {
    config,
    grid,
    streams,
    context,
    effectUses: witness.uses,
    chargeRequests,
    stateSlot,
  };
}

/* ==========================================================================
 * 3. The payload, and the two ways of dispatching it
 * ========================================================================== */

/**
 * One merge payload and the two live `Tile` objects it carries as its `source`
 * and `target`. A `Tile` satisfies `ReadonlyTileView` structurally, and it
 * satisfies the operand shape `config.merge.canMerge` reads, so the payload is
 * built from the tiles themselves.
 */
interface MergeCase {
  readonly payload: MergePayload;
  readonly source: Tile;
  readonly target: Tile;
}

/**
 * Builds one merge of two equal tiles, laid out as the `merge-pair` fixture
 * lays them: the moving tile at (1, 0) running into the target at (0, 0).
 *
 * @param value Face value both tiles carry.
 * @param resultValue Value the merge produces.
 * @param scoreDelta Points the merge scores before any relic transforms it.
 * @returns The payload and the two tiles.
 */
function buildMerge(
  value: number,
  resultValue: number,
  scoreDelta: number,
): MergeCase {
  const source = new Tile({ x: 1, y: 0 }, value);
  const target = new Tile({ x: 0, y: 0 }, value);

  return {
    payload: { source, target, resultValue, scoreDelta },
    source,
    target,
  };
}

/**
 * Invokes the handler once.
 *
 * `HookHandler` declares a return of the payload or nothing, so an absent
 * return is read here as `undefined`.
 *
 * @param bench Bench to dispatch over.
 * @param payload Payload to hand the handler.
 * @returns What the handler returned.
 */
function invoke(
  bench: Bench,
  payload: MergePayload,
): MergePayload | undefined {
  const returned = ON_MERGE(payload, bench.context);

  return returned === undefined ? undefined : returned;
}

/**
 * Invokes the handler and requires a payload back.
 *
 * @param bench Bench to dispatch over.
 * @param payload Payload to hand the handler.
 * @returns The payload the handler returned.
 * @throws {Error} If the handler returned nothing.
 */
function resolved(bench: Bench, payload: MergePayload): MergePayload {
  const returned = invoke(bench, payload);

  if (returned === undefined) {
    throw new Error(`The ${RELIC_ID} handler returned no payload.`);
  }

  return returned;
}

/**
 * The bench each test below dispatches over. Rebuilt before every test, so the
 * rules object, the board, the substreams and the state slot are fresh for each
 * one and no test reads what another left behind.
 */
let bench: Bench;

beforeEach(() => {
  bench = createBench();
});

/* ==========================================================================
 * 4. Property 1: the hooks it binds, and no others
 * ========================================================================== */

describe('echo-chamber: the declaration', () => {
  it('is declared by merge-magic and held in the catalogue', () => {
    expect(DECLARATION.id).toBe(RELIC_ID);
    expect(DECLARATION.name).toBe('Echo Chamber');
    expect(findRelicById(RELIC_ID)).toBe(DECLARATION);
  });

  it('carries the rarity the family assigns its first relic', () => {
    expect(DECLARATION.rarity).toBe(RARITIES[0]);
  });

  it('describes the quarter its arithmetic adds', () => {
    expect(DECLARATION.description).toContain('quarter');
    expect(SCORE_BONUS_FRACTION).toBe(0.25);
  });
});

describe('echo-chamber: the hooks it binds', () => {
  it('binds onMerge and no other hook', () => {
    expect(Object.keys(DECLARATION.hooks)).toEqual(['onMerge']);
  });

  it('binds only names HOOK_NAMES declares', () => {
    for (const name of Object.keys(DECLARATION.hooks)) {
      expect(HOOK_NAME_SET.has(name)).toBe(true);
    }
  });

  it('omits the five hooks it does not bind', () => {
    for (const name of HOOK_NAMES) {
      if (name === 'onMerge') {
        continue;
      }

      expect(name in DECLARATION.hooks).toBe(false);
    }

    expect('onSpawn' in DECLARATION.hooks).toBe(false);
    expect('onStageEnd' in DECLARATION.hooks).toBe(false);
  });

  it('binds a function under every name it declares', () => {
    for (const bound of Object.values(DECLARATION.hooks)) {
      expect(typeof bound).toBe('function');
    }

    expect(typeof DECLARATION.hooks.onMerge).toBe('function');
  });
});

/* ==========================================================================
 * 5. Property 2: the specified effect, and the decoupling it proves
 * ========================================================================== */

describe('echo-chamber: the baseline a merge enters with', () => {
  it('enters from a pair the rules in force merge', () => {
    const built = buildMerge(2, 4, 4);

    expect(bench.config.merge.canMerge(built.source, built.target)).toBe(true);
    expect(bench.config.merge.produce(built.source, built.target)).toBe(4);
  });

  it('enters with scoreDelta equal to resultValue', () => {
    const built = buildMerge(2, 4, 4);

    expect(built.payload.scoreDelta).toBe(built.payload.resultValue);
  });
});

describe('echo-chamber: adds a quarter of resultValue to scoreDelta', () => {
  it('raises a merge producing 4 from 4 points to 5', () => {
    const returned = resolved(bench, buildMerge(2, 4, 4).payload);

    expect(returned.scoreDelta).toBe(5);
  });

  it('leaves resultValue exactly as it arrived', () => {
    const returned = resolved(bench, buildMerge(2, 4, 4).payload);

    expect(returned.resultValue).toBe(4);
  });

  it('adds the floored quarter across the whole ladder', () => {
    for (const resultValue of [4, 8, 16, 32, 64, 128, 1024, 2048]) {
      const built = buildMerge(resultValue / 2, resultValue, resultValue);
      const returned = resolved(bench, built.payload);

      expect(returned.scoreDelta).toBe(
        resultValue + Math.floor(resultValue * SCORE_BONUS_FRACTION),
      );
      expect(returned.resultValue).toBe(resultValue);
    }
  });

  it('scales the bonus with the value, not by a flat point', () => {
    const small = resolved(bench, buildMerge(2, 4, 4).payload);
    const large = resolved(bench, buildMerge(512, 1024, 1024).payload);

    expect(small.scoreDelta).toBe(5);
    expect(large.scoreDelta).toBe(1280);
    expect(small.scoreDelta - 4).toBe(1);
    expect(large.scoreDelta - 1024).toBe(256);
  });

  it('floors a fractional bonus, raising 6 points to 7', () => {
    const returned = resolved(bench, buildMerge(3, 6, 6).payload);

    expect(returned.scoreDelta).toBe(7);
    expect(returned.resultValue).toBe(6);
  });

  it('leaves a merge whose floored bonus is zero alone', () => {
    const returned = resolved(bench, buildMerge(1, 2, 2).payload);

    expect(returned.scoreDelta).toBe(2);
    expect(returned.resultValue).toBe(2);
  });

  it('leaves a non-finite resultValue alone', () => {
    const infinite = resolved(
      bench,
      buildMerge(2, Number.POSITIVE_INFINITY, 4).payload,
    );
    const notANumber = resolved(bench, buildMerge(2, Number.NaN, 4).payload);

    expect(infinite.scoreDelta).toBe(4);
    expect(infinite.resultValue).toBe(Number.POSITIVE_INFINITY);
    expect(notANumber.scoreDelta).toBe(4);
    expect(Number.isNaN(notANumber.scoreDelta)).toBe(false);
    expect(Number.isNaN(notANumber.resultValue)).toBe(true);
  });

  it('never lowers scoreDelta', () => {
    const returned = resolved(bench, buildMerge(2, -8, 4).payload);

    expect(returned.scoreDelta).toBe(4);
  });

  it('returns a payload rather than nothing', () => {
    const raised = invoke(bench, buildMerge(2, 4, 4).payload);
    const unraised = invoke(bench, buildMerge(1, 2, 2).payload);

    expect(raised).toBeDefined();
    expect(unraised).toBeDefined();
  });

  it('leaves the payload it was given unwritten', () => {
    const built = buildMerge(2, 4, 4);
    const returned = resolved(bench, built.payload);

    expect(built.payload.scoreDelta).toBe(4);
    expect(built.payload.resultValue).toBe(4);
    expect(returned).not.toBe(built.payload);
  });

  it('compounds on its own return, 64 to 80 and then to 96', () => {
    const built = buildMerge(32, 64, 64);
    const once = resolved(bench, built.payload);
    const twice = resolved(bench, once);

    expect(once.scoreDelta).toBe(80);
    expect(twice.scoreDelta).toBe(96);
    expect(twice.resultValue).toBe(64);
  });
});

describe('echo-chamber: what one merge leaves untouched', () => {
  it('leaves both payload tiles exactly as they arrived', () => {
    const built = buildMerge(2, 4, 4);
    const returned = resolved(bench, built.payload);

    expect(returned.source).toBe(built.payload.source);
    expect(returned.target).toBe(built.payload.target);
    expect(returned.source.value).toBe(2);
    expect(returned.target.value).toBe(2);
    expect(returned.source.x).toBe(1);
    expect(returned.source.y).toBe(0);
    expect(returned.target.x).toBe(0);
    expect(returned.target.y).toBe(0);
  });

  it('writes neither of the live tiles it was handed', () => {
    const built = buildMerge(2, 4, 4);

    resolved(bench, built.payload);

    expect(built.source.value).toBe(2);
    expect(built.target.value).toBe(2);
    expect(built.source.x).toBe(1);
    expect(built.source.y).toBe(0);
    expect(built.target.x).toBe(0);
    expect(built.target.y).toBe(0);
    expect(built.source.mergedFrom).toBeNull();
    expect(built.target.mergedFrom).toBeNull();
    expect(built.source.previousPosition).toBeNull();
    expect(built.target.previousPosition).toBeNull();
  });

  it('leaves the rules in force unchanged', () => {
    const before = {
      boardSize: bench.config.boardSize,
      winValue: bench.config.winValue,
      startTiles: bench.config.startTiles,
      spawn: bench.config.spawn,
      merge: bench.config.merge,
      canMerge: bench.config.merge.canMerge,
      produce: bench.config.merge.produce,
      values: bench.config.spawn.values.slice(),
      weights: bench.config.spawn.weights.slice(),
    };

    resolved(bench, buildMerge(2, 4, 4).payload);

    expect(bench.config.boardSize).toBe(before.boardSize);
    expect(bench.config.winValue).toBe(before.winValue);
    expect(bench.config.startTiles).toBe(before.startTiles);
    expect(bench.config.spawn).toBe(before.spawn);
    expect(bench.config.merge).toBe(before.merge);
    expect(bench.config.merge.canMerge).toBe(before.canMerge);
    expect(bench.config.merge.produce).toBe(before.produce);
    expect(bench.config.spawn.values).toEqual(before.values);
    expect(bench.config.spawn.weights).toEqual(before.weights);
  });

  it('leaves the board unchanged and records no board effect', () => {
    const before = bench.grid.serialize();

    resolved(bench, buildMerge(2, 4, 4).payload);

    expect(bench.grid.serialize()).toEqual(before);
    expect(bench.effectUses).toEqual([]);
    expect(bench.context.effects.length).toBe(0);
    expect(bench.context.effects.refused).toBe(0);
  });

  it('leaves its own state slot exactly as it was handed over', () => {
    resolved(bench, buildMerge(2, 4, 4).payload);

    expect(bench.context.state).toBe(bench.stateSlot);
    expect(bench.stateSlot).toEqual({ untouched: true });
  });

  it('is dispatched over a context carrying the correlation id', () => {
    expect(bench.context.correlationId).toBe(RUN_CORRELATION_ID);
    expect(bench.context.correlationId).not.toBe('');

    resolved(bench, buildMerge(2, 4, 4).payload);

    expect(bench.context.correlationId).toBe(RUN_CORRELATION_ID);
  });
});

/* ==========================================================================
 * 6. Property 3: charges, including a dispatch at zero
 * ========================================================================== */

describe('echo-chamber: charges, including a dispatch at zero', () => {
  it('declares no charge budget and no state slot', () => {
    expect('charges' in DECLARATION).toBe(false);
    expect(DECLARATION.charges).toBeUndefined();
    expect('state' in DECLARATION).toBe(false);
    expect(DECLARATION.state).toBeUndefined();
  });

  it('reads no charge budget in its handler', () => {
    expect(HANDLER_SOURCE).not.toContain('charges');
    expect(HANDLER_SOURCE).not.toContain('spendCharge');
  });

  it('asks for no charge on a merge it raised', () => {
    const returned = resolved(bench, buildMerge(2, 4, 4).payload);

    expect(returned.scoreDelta).toBe(5);
    expect(bench.chargeRequests).toEqual([]);
  });

  it('neither throws nor corrupts anything at zero charges', () => {
    const spent = createBench(0);
    const built = buildMerge(2, 4, 4);
    const board = spent.grid.serialize();
    const predicate = spent.config.merge.canMerge;

    expect(() => invoke(spent, built.payload)).not.toThrow();

    const returned = resolved(spent, built.payload);

    expect(spent.context.charges).toBe(0);
    expect(returned.resultValue).toBe(4);
    expect(returned.scoreDelta).toBe(5);
    expect(spent.chargeRequests).toEqual([]);
    expect(spent.grid.serialize()).toEqual(board);
    expect(spent.config.merge.canMerge).toBe(predicate);
    expect(spent.context.state).toBe(spent.stateSlot);
    expect(spent.stateSlot).toEqual({ untouched: true });
    expect(spent.effectUses).toEqual([]);
  });
});

/* ==========================================================================
 * 7. Determinism and substream hygiene
 * ========================================================================== */

describe('echo-chamber: determinism', () => {
  it('leaves all four substream cursors where they stood', () => {
    const before = bench.streams.snapshotCursors();

    resolved(bench, buildMerge(512, 1024, 1024).payload);
    resolved(bench, buildMerge(2, 4, 4).payload);

    const after = bench.streams.snapshotCursors();

    for (const name of RNG_STREAM_NAMES) {
      expect(after[name]).toBe(before[name]);
      expect(after[name]).toBe(0);
    }
  });

  it('takes no unseeded randomness', () => {
    expect(HANDLER_SOURCE).not.toContain('Math.random');
    expect(bench.context.rng.seed).toBe(RUN_SEED);
  });

  it('suppresses no error and writes no log of its own', () => {
    expect(HANDLER_SOURCE).not.toContain('catch');
    expect(HANDLER_SOURCE).not.toContain('console');
  });

  it('reads no clock', () => {
    expect(HANDLER_SOURCE).not.toContain('Date');
    expect(HANDLER_SOURCE).not.toContain('performance');
  });
});

/* ==========================================================================
 * 8. The shared declaration, after every dispatch above
 * ========================================================================== */

describe('echo-chamber: the shared declaration after the suite', () => {
  it('is frozen at the declaration and at its hook table', () => {
    expect(Object.isFrozen(DECLARATION)).toBe(true);
    expect(Object.isFrozen(DECLARATION.hooks)).toBe(true);
  });

  it('carries the members it carried when this file loaded', () => {
    expect(project(DECLARATION)).toEqual(AT_LOAD);
    expect(project(readDeclaration())).toEqual(AT_LOAD);
    expect(readOnMergeHandler(DECLARATION)).toBe(ON_MERGE);
  });
});
