// Isolation suite for the `risk-reward-cursed` relic `hollow-ascension`: the
// three properties AAP 0.6.3 Group 5 requires of every relic — that it fires
// only on the hooks it binds, that it produces its specified effect, and that
// it respects `charges`, a zero-charge invocation included.
//
// Decisions behind this file are argued in docs/DECISION_LOG.md.
//
// This suite reads no DOM — tests/unit/relics runs in the `unit:dom-free`
// project of vitest.config.ts — consumes no randomness, reads no clock, starts
// no timer and touches no network.

import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import {
  createDefaultStageConfig,
  evaluateStageGoal,
  stageGoalForIndex,
} from '../../../src/config/stage-config';
import { Grid } from '../../../src/engine/grid';
import {
  HOOK_NAMES,
  type BoardEffectQueue,
  type HookContext,
  type HookHandler,
  type HookName,
  type MergePayload,
  type ReadonlyGridView,
  type StageEndPayload,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import type { CorrelationId, Position } from '../../../src/engine/types';
import {
  RISK_REWARD_CURSED_FAMILY,
} from '../../../src/relics/families/risk-reward-cursed';
import { findRelicById } from '../../../src/relics/relic-registry';
import type { PersistedRelic, Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
  type RngCursorMap,
  type RngStreams,
} from '../../../src/rng/rng-streams';
import { MERGE_PAIR_BOARD } from '../../fixtures/boards';

/** Identifier of the relic this suite holds. */
const RELIC_ID = 'hollow-ascension';

/** Family that declares it, named as the `RelicFamilyName` union spells it. */
const FAMILY_NAME = 'risk-reward-cursed';

/**
 * Resolves the relic out of its own family's declaration list.
 *
 * @param id Identifier to resolve.
 * @returns The declared relic.
 * @throws {Error} When the family declares no relic under `id`.
 */
function requireDeclaredRelic(id: string): Relic {
  const found = RISK_REWARD_CURSED_FAMILY.relics.find(
    (relic) => relic.id === id,
  );

  if (found === undefined) {
    throw new Error(
      `hollow-ascension.test.ts: the ${FAMILY_NAME} family declares no ` +
        `relic '${id}'.`,
    );
  }

  return found;
}

/** The relic under test, resolved once. */
const RELIC: Relic = requireDeclaredRelic(RELIC_ID);

/** The two hooks the relic binds, in `HOOK_NAMES` order. */
const BOUND_HOOKS: readonly HookName[] = ['onMerge', 'onStageEnd'];

/** The four hooks it does not bind, in `HOOK_NAMES` order. */
const UNBOUND_HOOKS: readonly HookName[] = [
  'onStageStart',
  'onBeforeMove',
  'onSpawn',
  'onAfterMove',
];

/**
 * The relic's declaration as it stood when this file was loaded, read back at
 * the end of the suite to prove nothing here wrote to the catalogue.
 */
const DECLARATION_AT_LOAD = Object.freeze({
  id: RELIC.id,
  name: RELIC.name,
  rarity: RELIC.rarity,
  description: RELIC.description,
  hookNames: Object.freeze([...Object.keys(RELIC.hooks)].sort()),
  onMerge: RELIC.hooks.onMerge,
  onStageEnd: RELIC.hooks.onStageEnd,
  charges: RELIC.charges,
  state: RELIC.state,
});

/**
 * Resolves the relic's `onMerge` handler.
 *
 * @returns The bound handler.
 * @throws {Error} When the relic no longer binds `onMerge`.
 */
function requireMergeHandler(): HookHandler<'onMerge'> {
  const handler = RELIC.hooks.onMerge;

  if (handler === undefined) {
    throw new Error(
      `hollow-ascension.test.ts: relic '${RELIC_ID}' binds no onMerge ` +
        `handler.`,
    );
  }

  return handler;
}

/**
 * Resolves the relic's `onStageEnd` handler.
 *
 * @returns The bound handler.
 * @throws {Error} When the relic no longer binds `onStageEnd`.
 */
function requireStageEndHandler(): HookHandler<'onStageEnd'> {
  const handler = RELIC.hooks.onStageEnd;

  if (handler === undefined) {
    throw new Error(
      `hollow-ascension.test.ts: relic '${RELIC_ID}' binds no onStageEnd ` +
        `handler.`,
    );
  }

  return handler;
}

/** Score the relic adds per charge already banked. */
const BONUS_PER_BANK = 4;

/** Charges the relic banks per merge dispatch. */
const BANK_STEP = 1;

/** Ceiling the bank is clamped to. */
const MAX_BANK = 4096;

/** Face value of each tile the merge payloads below describe. */
const PAIR_VALUE = 2;

/** Value that pair produces, `tile.value * 2` at js/game_manager.js L157. */
const PRODUCED_VALUE = PAIR_VALUE * 2;

/**
 * Bonus a dispatch pays when `bank` charges stood in the slot as it began.
 *
 * @param bank Charges banked before the dispatch.
 * @returns The score the dispatch adds on top of the accumulated
 *   contribution.
 */
function bonusFor(bank: number): number {
  return Math.floor(bank * BONUS_PER_BANK);
}

/**
 * Bank the slot holds after a dispatch that began with `bank` charges.
 *
 * @param bank Charges banked before the dispatch.
 * @returns The clamped bank.
 */
function bankAfter(bank: number): number {
  return Math.min(bank + BANK_STEP, MAX_BANK);
}

/** Seed every context this suite builds derives its substreams from. */
const SUITE_SEED = 'hollow-ascension-suite';

/** Correlation identifier the bus injects and the context carries verbatim. */
const SUITE_CORRELATION_ID: CorrelationId = 'run-hollow-ascension-suite';

/**
 * Pickup position the context reports. The relic reads neither it nor the
 * subscriber identifier.
 */
const SUITE_PICKUP_ORDER = 1;

/** The board-write channel, recording every call and accepting none. */
interface EffectsProbe extends BoardEffectQueue {
  /** Every call made against the channel, in call order. */
  readonly calls: readonly string[];
}

/**
 * Builds the query view of a live board: the eight members `ReadonlyGridView`
 * declares, each reading the board at call time.
 *
 * @param grid Live board to read.
 * @returns The frozen query view.
 */
function createGridView(grid: Grid): ReadonlyGridView {
  const view: ReadonlyGridView = {
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

  return Object.freeze(view);
}

/**
 * Builds a board-write channel that records every call and accepts none.
 *
 * @param view Query view the read members delegate to.
 * @returns The probe.
 */
function createEffectsProbe(view: ReadonlyGridView): EffectsProbe {
  const calls: string[] = [];

  const record = (call: string, ...args: readonly unknown[]): false => {
    calls.push(`${call}/${String(args.length)}`);

    return false;
  };

  const probe: EffectsProbe = {
    calls,
    get size(): number {
      return view.size;
    },
    get length(): number {
      return 0;
    },
    get refused(): number {
      return calls.length;
    },
    insertTile: (cell, value) => record('insertTile', cell, value),
    removeTile: (cell) => record('removeTile', cell),
    moveTile: (from, to, tween) => record('moveTile', from, to, tween),
    restoreBoard: (snapshot, score) => record('restoreBoard', snapshot, score),
    resizeBoard: (size) => record('resizeBoard', size),
    setMergePredicate: (predicate) => record('setMergePredicate', predicate),
    setSpawnWeights: (weights) => record('setSpawnWeights', weights),
    request: (effect) => record('request', effect),
    requested: () => Object.freeze([]),
    cellValue: (cell) => view.cellValue(cell),
    cellOccupied: (cell) => view.cellOccupied(cell),
    availableCells: () => view.availableCells(),
    occupiedCells: () => Object.freeze([]),
    clear: () => {
      record('clear');
    },
  };

  return probe;
}

/** One test's collaborators, rebuilt for every test. */
interface Bench {
  /** The live rules, fresh and writable. */
  readonly config: RulesConfig;

  /** The live board the context's view reads. */
  readonly grid: Grid;

  /** The query view of that board. */
  readonly view: ReadonlyGridView;

  /** The run's named seeded substreams. */
  readonly streams: RngStreams;

  /** The board-write channel. */
  readonly effects: EffectsProbe;

  /** Every charge amount a handler asked the bus to spend. */
  readonly chargeRequests: number[];

  /**
   * The subscriber's own state slot: the bank's home, carried into each
   * dispatch and written back out of it as src/engine/hook-bus.ts does.
   */
  slot: unknown;
}

/**
 * Builds a bench seating the relic alone.
 *
 * @returns The assembled bench.
 */
function createBench(): Bench {
  const config = createDefaultRulesConfig();
  const grid = new Grid(
    MERGE_PAIR_BOARD.grid.size,
    MERGE_PAIR_BOARD.grid.cells,
  );
  const view = createGridView(grid);

  return {
    config,
    grid,
    view,
    streams: createRngStreams(SUITE_SEED),
    effects: createEffectsProbe(view),
    chargeRequests: [],
    slot: RELIC.state,
  };
}

/**
 * Builds the context one dispatch receives.
 *
 * @param bench Bench the context reads and writes.
 * @param hook Hook being dispatched.
 * @param charges Budget the notional subscription holds, absent for a
 *   subscriber carrying none.
 * @returns The context, carrying the bench's slot by value.
 */
function contextFor(
  bench: Bench,
  hook: HookName,
  charges?: number,
): HookContext {
  return {
    config: bench.config,
    rng: bench.streams,
    grid: bench.view,
    effects: bench.effects,
    correlationId: SUITE_CORRELATION_ID,
    hook,
    subscriberId: RELIC_ID,
    pickupOrder: SUITE_PICKUP_ORDER,
    charges,
    spendCharge: (amount?: number): boolean => {
      bench.chargeRequests.push(amount ?? 1);

      return false;
    },
    state: bench.slot,
  };
}

/**
 * Invokes the `onMerge` handler over a context built for this dispatch and
 * copies whatever the handler left in the slot back onto the bench.
 *
 * @param bench Bench to dispatch against.
 * @param payload Merge to dispatch with.
 * @param charges Budget the notional subscription holds.
 * @returns The payload the handler returned, or nothing where it returned
 *   nothing.
 */
function dispatchMerge(
  bench: Bench,
  payload: MergePayload,
  charges?: number,
): MergePayload | void {
  const context = contextFor(bench, 'onMerge', charges);
  const resolved = requireMergeHandler()(payload, context);

  bench.slot = context.state;

  return resolved;
}

/**
 * Invokes the `onStageEnd` handler over a context built for this dispatch and
 * copies whatever the handler left in the slot back onto the bench.
 *
 * @param bench Bench to dispatch against.
 * @param payload Stage result to dispatch with.
 * @param charges Budget the notional subscription holds.
 * @returns The payload the handler returned, or nothing where it returned
 *   nothing.
 */
function dispatchStageEnd(
  bench: Bench,
  payload: StageEndPayload,
  charges?: number,
): StageEndPayload | void {
  const context = contextFor(bench, 'onStageEnd', charges);
  const resolved = requireStageEndHandler()(payload, context);

  bench.slot = context.state;

  return resolved;
}

/**
 * Reads the bank the bench's slot holds.
 *
 * @param bench Bench to read.
 * @returns The banked charge count.
 * @throws {Error} When the slot holds anything but a number, which is the
 *   corruption the zero-charge and empty-bank cases below rule out.
 */
function bankOf(bench: Bench): number {
  const slot = bench.slot;

  if (typeof slot !== 'number') {
    throw new Error(
      `hollow-ascension.test.ts: the state slot holds ${typeof slot}, not a ` +
        `number: ${String(slot)}`,
    );
  }

  return slot;
}

/** Cell the merge's source tile stands in, row 0 of the merge-pair fixture. */
const SOURCE_CELL: Position = { x: 1, y: 0 };

/** Cell the merge's target tile stands in. */
const TARGET_CELL: Position = { x: 0, y: 0 };

/** One merge, with the two live tiles it was projected from. */
interface MergeCase {
  readonly payload: MergePayload;
  readonly source: Tile;
  readonly target: Tile;
}

/**
 * Builds one merge of a pair of `2`s.
 *
 * @param scoreDelta Contribution the merge arrives carrying. Defaults to the
 *   value the produced tile carries, which is what js/game_manager.js L167
 *   accrued.
 * @param resultValue Value the merge produces. Defaults to `tile.value * 2`.
 * @returns The merge and its two tiles.
 */
function mergeCase(
  scoreDelta: number = PRODUCED_VALUE,
  resultValue: number = PRODUCED_VALUE,
): MergeCase {
  const source = new Tile(SOURCE_CELL, PAIR_VALUE);
  const target = new Tile(TARGET_CELL, PAIR_VALUE);

  source.savePosition();
  target.savePosition();

  return {
    payload: { source, target, resultValue, scoreDelta },
    source,
    target,
  };
}

/** Stage index every stage result below reports. */
const STAGE_INDEX = 0;

/** Score every stage result below reports, unless it states another. */
const STAGE_SCORE = 96;

/**
 * Builds one stage result.
 *
 * @param cleared Whether the stage was cleared.
 * @param score Score the stage ended on.
 * @returns The stage result.
 */
function stageEnd(
  cleared: boolean,
  score: number = STAGE_SCORE,
): StageEndPayload {
  return { stageIndex: STAGE_INDEX, cleared, score };
}

/** The goal stage `STAGE_INDEX` resolves against under the default ladder. */
const STAGE_GOAL = stageGoalForIndex(STAGE_INDEX, createDefaultStageConfig());

/**
 * @param highestTileValue Highest tile value the board held.
 * @param score Score the stage ended on.
 * @returns The stage result, carrying the evaluated verdict.
 */
function evaluatedStageEnd(
  highestTileValue: number,
  score: number = STAGE_SCORE,
): StageEndPayload {
  const progress = evaluateStageGoal(STAGE_GOAL, { score, highestTileValue });

  return { stageIndex: STAGE_INDEX, cleared: progress.cleared, score };
}

/**
 * Asserts that no substream advanced across a dispatch.
 *
 * @param before Cursors as they stood before the dispatch.
 * @param after Cursors as they stand after it.
 */
function expectNoDraw(before: RngCursorMap, after: RngCursorMap): void {
  expect([...Object.keys(after)].sort()).toEqual([...RNG_STREAM_NAMES].sort());

  for (const name of RNG_STREAM_NAMES) {
    expect(after[name], `${name} cursor`).toBe(before[name]);
  }
}

/**
 * Asserts that a dispatch left a merge's two tiles exactly as it found them.
 *
 * @param subject The merge whose tiles are read.
 */
function expectTilesUntouched(subject: MergeCase): void {
  expect(subject.source.value).toBe(PAIR_VALUE);
  expect(subject.target.value).toBe(PAIR_VALUE);
  expect({ x: subject.source.x, y: subject.source.y }).toEqual(SOURCE_CELL);
  expect({ x: subject.target.x, y: subject.target.y }).toEqual(TARGET_CELL);
  expect(subject.source.previousPosition).toEqual(SOURCE_CELL);
  expect(subject.target.previousPosition).toEqual(TARGET_CELL);
  expect(subject.source.mergedFrom).toBeNull();
  expect(subject.target.mergedFrom).toBeNull();
}

/**
 * Asserts that a dispatch reached neither the board nor the charge budget.
 *
 * @param bench Bench the dispatch ran against.
 */
function expectNoSideChannel(bench: Bench): void {
  expect(bench.effects.calls).toEqual([]);
  expect(bench.effects.length).toBe(0);
  expect(bench.effects.refused).toBe(0);
  expect(bench.chargeRequests).toEqual([]);
}

/**
 * Reads the values a board holds, x-outer and y-inner, empty cells as `null`.
 *
 * @param grid Board to read.
 * @returns One entry per cell.
 */
function boardValues(grid: Grid): (number | null)[] {
  const found: (number | null)[] = [];

  grid.eachCell((_x, _y, tile) => {
    found.push(tile === null ? null : tile.value);
  });

  return found;
}

/**
 * Projects the rules to the members a relic could plausibly write.
 *
 * @param config Rules to read.
 * @returns A plain, comparable projection.
 */
function rulesProjection(config: RulesConfig): unknown {
  return {
    boardSize: config.boardSize,
    winValue: config.winValue,
    startTiles: config.startTiles,
    spawnValues: [...config.spawn.values],
    spawnWeights: [...config.spawn.weights],
    canMerge: config.merge.canMerge,
    produce: config.merge.produce,
  };
}

/** Rebuilt before every test: fresh rules, fresh board, fresh slot. */
let bench: Bench;

beforeEach(() => {
  bench = createBench();
});

describe('hollow-ascension: the hooks it binds', () => {
  it('is declared by the risk-reward-cursed family and reachable by id', () => {
    expect(RISK_REWARD_CURSED_FAMILY.name).toBe(FAMILY_NAME);
    expect(RELIC.id).toBe(RELIC_ID);

    expect(findRelicById(RELIC_ID)).toBe(RELIC);
  });

  it('binds exactly onMerge and onStageEnd, and nothing else', () => {
    expect([...Object.keys(RELIC.hooks)].sort()).toEqual(
      [...BOUND_HOOKS].sort(),
    );
  });

  it('binds only names that HOOK_NAMES declares', () => {
    for (const name of Object.keys(RELIC.hooks)) {
      expect(HOOK_NAMES, `hook ${name}`).toContain(name);
    }

    // The corpus check for the loop above: a relic binding nothing would pass
    // it silently.
    expect(Object.keys(RELIC.hooks)).toHaveLength(BOUND_HOOKS.length);
    expect(BOUND_HOOKS).toHaveLength(2);
  });

  it('omits the four hooks it does not bind rather than declaring them as ' +
    'undefined', () => {
    for (const name of UNBOUND_HOOKS) {
      expect(name in RELIC.hooks, `${name} absent`).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(RELIC.hooks, name)).toBe(
        false,
      );
    }

    expect(UNBOUND_HOOKS).toHaveLength(HOOK_NAMES.length - BOUND_HOOKS.length);
  });

  it('binds a function under each of the two names', () => {
    expect(typeof RELIC.hooks.onMerge).toBe('function');
    expect(typeof RELIC.hooks.onStageEnd).toBe('function');
    expect(requireMergeHandler()).toBe(RELIC.hooks.onMerge);
    expect(requireStageEndHandler()).toBe(RELIC.hooks.onStageEnd);
  });

  it('reads the bank the other binding wrote, through one shared state slot',
    () => {
      // One context object reaches both handlers here, which is the single
      // slot src/relics/relic-registry.ts holds per subscriber.
      const context = contextFor(bench, 'onMerge');

      expect(context.state).toBe(RELIC.state);

      requireMergeHandler()(mergeCase().payload, context);
      requireMergeHandler()(mergeCase().payload, context);

      expect(context.state).toBe(bankAfter(bankAfter(0)));

      requireStageEndHandler()(stageEnd(false), context);

      expect(context.state).toBe(0);
    });

  it('holds no module-level state: two slots run the same cycle ' +
    'independently', () => {
    /** Runs the full bank-then-empty cycle and reports what it observed. */
    const cycle = (): { banked: number; emptied: number; paid: number } => {
      const target = createBench();

      dispatchMerge(target, mergeCase().payload);

      const second = dispatchMerge(target, mergeCase().payload);
      const banked = bankOf(target);

      dispatchStageEnd(target, stageEnd(false));

      return {
        banked,
        emptied: bankOf(target),
        paid: second === undefined ? PRODUCED_VALUE : second.scoreDelta,
      };
    };

    const first = cycle();
    const repeat = cycle();

    expect(first).toEqual({
      banked: bankAfter(bankAfter(0)),
      emptied: 0,
      paid: PRODUCED_VALUE + bonusFor(bankAfter(0)),
    });
    expect(repeat).toEqual(first);
  });

  it('opens every run at an empty bank held as a bare number', () => {
    expect(RELIC.state).toBe(0);
    expect(typeof RELIC.state).toBe('number');
    expect(bankOf(bench)).toBe(0);
  });
});

describe('hollow-ascension: banking a merge', () => {
  it('banks one charge on the first merge and pays nothing for it', () => {
    const subject = mergeCase();
    const resolved = dispatchMerge(bench, subject.payload);

    // The bank stood at zero, so the bonus is zero and the handler returns
    // nothing, which src/engine/hooks.ts records as leaving the accumulated
    // payload as it stands.
    expect(bonusFor(0)).toBe(0);
    expect(resolved).toBeUndefined();
    expect(bankOf(bench)).toBe(bankAfter(0));
  });

  it('banks a further charge on every merge after it', () => {
    dispatchMerge(bench, mergeCase().payload);

    expect(bankOf(bench)).toBe(1);

    dispatchMerge(bench, mergeCase().payload);

    expect(bankOf(bench)).toBe(2);

    dispatchMerge(bench, mergeCase().payload);

    expect(bankOf(bench)).toBe(3);
  });

  it('adds four points per banked charge to the contribution, exactly', () => {
    const first = dispatchMerge(bench, mergeCase().payload);
    const second = dispatchMerge(bench, mergeCase().payload);
    const third = dispatchMerge(bench, mergeCase().payload);

    expect(first).toBeUndefined();
    expect(second?.scoreDelta).toBe(PRODUCED_VALUE + bonusFor(1));
    expect(third?.scoreDelta).toBe(PRODUCED_VALUE + bonusFor(2));

    // The same three numbers stated without the helpers, so a change to
    // bonusFor cannot move the specification and the assertion together.
    expect(second?.scoreDelta).toBe(8);
    expect(third?.scoreDelta).toBe(12);
  });

  it('adds the bonus to what the payload already accumulated', () => {
    dispatchMerge(bench, mergeCase().payload);

    const accumulated = 100;
    const resolved = dispatchMerge(bench, mergeCase(accumulated).payload);

    expect(resolved?.scoreDelta).toBe(accumulated + bonusFor(1));
    expect(resolved?.scoreDelta).toBe(104);
  });

  it('carries resultValue across untouched, so no bonus reaches the board',
    () => {
      dispatchMerge(bench, mergeCase().payload);

      const subject = mergeCase();
      const resolved = dispatchMerge(bench, subject.payload);

      // js/game_manager.js L167 accrued `merged.value`, so scoreDelta and
      // resultValue carry the same number under the default rules.
      expect(resolved?.resultValue).toBe(PRODUCED_VALUE);
      expect(subject.payload.resultValue).toBe(PRODUCED_VALUE);
      expect(resolved?.resultValue).not.toBe(resolved?.scoreDelta);
      expect(bench.config.winValue).toBe(2048);
    });

  it('returns the two tile projections it was given, unchanged', () => {
    dispatchMerge(bench, mergeCase().payload);

    const subject = mergeCase();
    const resolved = dispatchMerge(bench, subject.payload);

    expect(resolved?.source).toBe(subject.source);
    expect(resolved?.target).toBe(subject.target);
    expectTilesUntouched(subject);
  });

  it('leaves the tiles alone on a dispatch that pays nothing', () => {
    const subject = mergeCase();

    dispatchMerge(bench, subject.payload);

    expectTilesUntouched(subject);
  });

  it('leaves the board, the rules and the charge budget alone', () => {
    const board = boardValues(bench.grid);
    const rules = rulesProjection(bench.config);

    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);

    expect(boardValues(bench.grid)).toEqual(board);
    expect(rulesProjection(bench.config)).toEqual(rules);
    expectNoSideChannel(bench);
  });

  it('banks the charge even where the contribution is not a finite number',
    () => {
      const resolved = dispatchMerge(bench, mergeCase(Number.NaN).payload);

      // The bank is written before the contribution is read, so a payload the
      // handler declines to transform still advances the run's bank.
      expect(resolved).toBeUndefined();
      expect(bankOf(bench)).toBe(bankAfter(0));

      const infinite = dispatchMerge(
        bench,
        mergeCase(Number.POSITIVE_INFINITY).payload,
      );

      expect(infinite).toBeUndefined();
      expect(bankOf(bench)).toBe(bankAfter(bankAfter(0)));
    });

  it('clamps the bank at four thousand and ninety-six charges', () => {
    bench.slot = MAX_BANK;

    const resolved = dispatchMerge(bench, mergeCase().payload);

    expect(bankOf(bench)).toBe(MAX_BANK);
    expect(resolved?.scoreDelta).toBe(PRODUCED_VALUE + bonusFor(MAX_BANK));
    expect(resolved?.scoreDelta).toBe(16388);
  });

  it('normalises a restored bank that is fractional, negative or beyond ' +
    'the ceiling', () => {
    /** Banks one merge over a restored slot and reports what it paid. */
    const payOver = (slot: unknown): { paid: number; bank: number } => {
      const target = createBench();

      target.slot = slot;

      const resolved = dispatchMerge(target, mergeCase().payload);

      return {
        paid: resolved === undefined ? PRODUCED_VALUE : resolved.scoreDelta,
        bank: bankOf(target),
      };
    };

    expect(payOver(2.7)).toEqual({
      paid: PRODUCED_VALUE + bonusFor(2),
      bank: bankAfter(2),
    });
    expect(payOver(-5)).toEqual({ paid: PRODUCED_VALUE, bank: bankAfter(0) });
    expect(payOver(MAX_BANK + 904)).toEqual({
      paid: PRODUCED_VALUE + bonusFor(MAX_BANK),
      bank: MAX_BANK,
    });
    expect(payOver(Number.NaN)).toEqual({
      paid: PRODUCED_VALUE,
      bank: bankAfter(0),
    });
  });

  it('reads a slot of the wrong shape as an empty bank without throwing',
    () => {
      for (const corrupted of [undefined, null, {}, [], 'four', true]) {
        const target = createBench();

        target.slot = corrupted;

        expect(() => dispatchMerge(target, mergeCase().payload)).not.toThrow();
        expect(bankOf(target)).toBe(bankAfter(0));
      }
    });
});

describe('hollow-ascension: the bank across a reload', () => {
  it('holds the bank as plain JSON that survives a round trip', () => {
    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);

    const banked = bankOf(bench);

    expect(banked).toBe(2);
    expect(Number.isInteger(banked)).toBe(true);
    expect(Number.isFinite(banked)).toBe(true);

    // Contract 5 persists the slot inside this envelope, and the envelope goes
    // through JSON.stringify whole.
    const envelope: PersistedRelic = { id: RELIC.id, state: banked };
    const restored: unknown = JSON.parse(JSON.stringify(envelope));

    expect(restored).toEqual({ id: RELIC_ID, state: 2 });
    expect(JSON.stringify(banked)).toBe('2');
  });

  it('resumes a restored bank rather than restarting it at zero', () => {
    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);

    const envelope: PersistedRelic = { id: RELIC.id, state: bankOf(bench) };
    const restored = JSON.parse(JSON.stringify(envelope)) as PersistedRelic;

    // A fresh slot, as a resumed run hands the bus, loaded from the envelope.
    const resumed = createBench();

    resumed.slot = restored.state;

    const resolved = dispatchMerge(resumed, mergeCase().payload);

    expect(resolved?.scoreDelta).toBe(PRODUCED_VALUE + bonusFor(2));
    expect(resolved?.scoreDelta).toBe(12);
    expect(bankOf(resumed)).toBe(bankAfter(2));
  });

  it('compounds over the payload an earlier handler returned', () => {
    // Contract 2 hands each handler the accumulated payload and takes back a
    // possibly transformed one, so feeding the return forward is what a second
    // relic on onMerge would see.
    const first = dispatchMerge(bench, mergeCase().payload);

    expect(first).toBeUndefined();

    const second = dispatchMerge(bench, mergeCase().payload);

    expect(second?.scoreDelta).toBe(8);

    const third = dispatchMerge(bench, second ?? mergeCase().payload);

    expect(third?.scoreDelta).toBe(8 + bonusFor(2));
    expect(third?.scoreDelta).toBe(16);
    expect(third?.resultValue).toBe(PRODUCED_VALUE);
    expect(bankOf(bench)).toBe(3);
  });

  it('returns a fresh payload rather than writing the one it was given',
    () => {
      dispatchMerge(bench, mergeCase().payload);

      const subject = mergeCase();
      const resolved = dispatchMerge(bench, subject.payload);

      expect(resolved).not.toBe(subject.payload);
      expect(subject.payload.scoreDelta).toBe(PRODUCED_VALUE);
      expect(subject.payload.resultValue).toBe(PRODUCED_VALUE);
    });
});

describe('hollow-ascension: a stage that was not cleared', () => {
  it('empties the banked charges when cleared is false', () => {
    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);

    expect(bankOf(bench)).toBe(3);

    dispatchStageEnd(bench, stageEnd(false));

    expect(bankOf(bench)).toBe(0);
  });

  it('leaves the next merge paying the base contribution again', () => {
    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);
    dispatchStageEnd(bench, stageEnd(false));

    const resolved = dispatchMerge(bench, mergeCase().payload);

    expect(resolved).toBeUndefined();
    expect(bankOf(bench)).toBe(bankAfter(0));
  });

  it('empties an already-empty bank without throwing', () => {
    expect(bankOf(bench)).toBe(0);
    expect(() => dispatchStageEnd(bench, stageEnd(false))).not.toThrow();
    expect(bankOf(bench)).toBe(0);
    expect(Number.isNaN(bankOf(bench))).toBe(false);
  });

  it('empties the bank idempotently, with no drift below zero', () => {
    dispatchMerge(bench, mergeCase().payload);
    dispatchStageEnd(bench, stageEnd(false));
    dispatchStageEnd(bench, stageEnd(false));
    dispatchStageEnd(bench, stageEnd(false));

    expect(bankOf(bench)).toBe(0);
    expect(bankOf(bench)).toBeGreaterThanOrEqual(0);
  });

  it('leaves a slot of the wrong shape holding a usable empty bank', () => {
    for (const corrupted of [undefined, null, {}, 'four']) {
      const target = createBench();

      target.slot = corrupted;

      expect(() => dispatchStageEnd(target, stageEnd(false))).not.toThrow();
      expect(bankOf(target)).toBe(0);
    }
  });
});

describe('hollow-ascension: a stage that was cleared', () => {
  it('preserves the banked charges when cleared is true', () => {
    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);

    const banked = bankOf(bench);

    expect(banked).toBe(3);

    dispatchStageEnd(bench, stageEnd(true));

    expect(bankOf(bench)).toBe(banked);
  });

  it('carries the bank into the next stage, still paying from it', () => {
    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);
    dispatchStageEnd(bench, stageEnd(true));

    const resolved = dispatchMerge(bench, mergeCase().payload);

    expect(resolved?.scoreDelta).toBe(PRODUCED_VALUE + bonusFor(2));
    expect(resolved?.scoreDelta).toBe(12);
    expect(bankOf(bench)).toBe(3);
  });

  it('leaves an empty bank empty rather than raising it', () => {
    expect(bankOf(bench)).toBe(0);

    dispatchStageEnd(bench, stageEnd(true));

    expect(bankOf(bench)).toBe(0);
  });

  it('leaves a slot of the wrong shape exactly as it found it', () => {
    const untouched = { note: 'not a bank' };

    bench.slot = untouched;

    expect(() => dispatchStageEnd(bench, stageEnd(true))).not.toThrow();
    expect(bench.slot).toEqual(untouched);
  });
});

describe('hollow-ascension: the two stage verdicts differ', () => {
  it('selects the branch on the boolean cleared member alone', () => {
    /** Banks two charges, ends the stage on `cleared`, reports the bank. */
    const endStageWith = (cleared: boolean): number => {
      const target = createBench();

      dispatchMerge(target, mergeCase().payload);
      dispatchMerge(target, mergeCase().payload);

      expect(bankOf(target)).toBe(2);

      dispatchStageEnd(target, stageEnd(cleared));

      return bankOf(target);
    };

    expect(endStageWith(false)).toBe(0);
    expect(endStageWith(true)).toBe(2);
    expect(endStageWith(false)).not.toBe(endStageWith(true));
  });

  it('reads the same verdict the stage-goal evaluator produces', () => {
    expect(STAGE_GOAL.kind).toBe('highest-tile');
    expect(STAGE_GOAL.target).toBe(16);

    const failed = evaluatedStageEnd(8);
    const passed = evaluatedStageEnd(16);

    expect(failed.cleared).toBe(false);
    expect(passed.cleared).toBe(true);

    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);
    dispatchStageEnd(bench, passed);

    expect(bankOf(bench)).toBe(2);

    dispatchStageEnd(bench, failed);

    expect(bankOf(bench)).toBe(0);
  });
});

describe('hollow-ascension: what onStageEnd does not do', () => {
  it('returns nothing on either branch, leaving the payload as it stands',
    () => {
      // The handler is declared `: void` in
      // src/relics/families/risk-reward-cursed.ts. src/engine/hooks.ts records
      // a handler returning nothing as leaving the accumulated payload as it
      // stands, which is what this relic relies on: it changes the bank and
      // never the stage result.
      dispatchMerge(bench, mergeCase().payload);

      expect(dispatchStageEnd(bench, stageEnd(true))).toBeUndefined();
      expect(dispatchStageEnd(bench, stageEnd(false))).toBeUndefined();
    });

  it('leaves stageIndex and score on the incoming payload untouched', () => {
    dispatchMerge(bench, mergeCase().payload);

    const failure = stageEnd(false, 1234);
    const success = stageEnd(true, 5678);

    dispatchStageEnd(bench, failure);
    dispatchStageEnd(bench, success);

    expect(failure).toEqual({
      stageIndex: STAGE_INDEX,
      cleared: false,
      score: 1234,
    });
    expect(success).toEqual({
      stageIndex: STAGE_INDEX,
      cleared: true,
      score: 5678,
    });
  });

  it('leaves the board, the rules and the charge budget alone', () => {
    const board = boardValues(bench.grid);
    const rules = rulesProjection(bench.config);

    dispatchMerge(bench, mergeCase().payload);
    dispatchStageEnd(bench, stageEnd(false));
    dispatchStageEnd(bench, stageEnd(true));

    expect(boardValues(bench.grid)).toEqual(board);
    expect(rulesProjection(bench.config)).toEqual(rules);
    expectNoSideChannel(bench);
  });
});

describe('hollow-ascension: charges', () => {
  it('declares no charge budget at all, rather than a null one', () => {
    expect('charges' in RELIC).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(RELIC, 'charges'),
    ).toBe(false);
    expect(RELIC.charges).toBeUndefined();
    expect(RELIC.charges).not.toBeNull();
  });

  it('reads no charge budget in either handler', () => {
    // Contract 2 keeps the guard in the bus.
    for (const [name, handler] of Object.entries(RELIC.hooks)) {
      expect(String(handler), `${name} source`).not.toContain('charges');
    }

    // The corpus check: two handlers were read, not zero.
    expect(Object.entries(RELIC.hooks)).toHaveLength(2);
  });

  it('asks the bus to spend nothing on either hook', () => {
    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);
    dispatchStageEnd(bench, stageEnd(true));
    dispatchStageEnd(bench, stageEnd(false));

    expect(bench.chargeRequests).toEqual([]);
  });

  it('throws nothing when either handler is invoked at zero charges', () => {
    for (const budget of [0, -1]) {
      const target = createBench();

      expect(() =>
        dispatchMerge(target, mergeCase().payload, budget),
      ).not.toThrow();
      expect(() =>
        dispatchStageEnd(target, stageEnd(false), budget),
      ).not.toThrow();
      expect(() =>
        dispatchStageEnd(target, stageEnd(true), budget),
      ).not.toThrow();
    }
  });

  it('leaves the bank a usable number after an invocation at zero charges',
    () => {
      dispatchMerge(bench, mergeCase().payload, 0);
      dispatchMerge(bench, mergeCase().payload, 0);

      const banked = bankOf(bench);

      expect(banked).toBe(2);
      expect(Number.isFinite(banked)).toBe(true);
      expect(Number.isNaN(banked)).toBe(false);
      expect(Number.isInteger(banked)).toBe(true);
      expect(banked).toBeGreaterThanOrEqual(0);
    });

  it('banks and empties correctly on the cycle after one made at zero',
    () => {
      dispatchMerge(bench, mergeCase().payload, 0);
      dispatchStageEnd(bench, stageEnd(false), 0);

      expect(bankOf(bench)).toBe(0);

      // The same cycle again, this time with no budget declared at all.
      dispatchMerge(bench, mergeCase().payload);

      const resolved = dispatchMerge(bench, mergeCase().payload);

      expect(resolved?.scoreDelta).toBe(PRODUCED_VALUE + bonusFor(1));
      expect(bankOf(bench)).toBe(2);

      dispatchStageEnd(bench, stageEnd(true));

      expect(bankOf(bench)).toBe(2);

      dispatchStageEnd(bench, stageEnd(false));

      expect(bankOf(bench)).toBe(0);
    });

  it('pays and banks the same amounts whatever budget the context reports',
    () => {
      /** Banks two merges against a reported budget and reports the pay. */
      const payUnder = (charges?: number): { paid: number; bank: number } => {
        const target = createBench();

        dispatchMerge(target, mergeCase().payload, charges);

        const resolved = dispatchMerge(target, mergeCase().payload, charges);

        return {
          paid: resolved === undefined ? PRODUCED_VALUE : resolved.scoreDelta,
          bank: bankOf(target),
        };
      };

      const expected = {
        paid: PRODUCED_VALUE + bonusFor(1),
        bank: bankAfter(bankAfter(0)),
      };

      expect(payUnder(undefined)).toEqual(expected);
      expect(payUnder(0)).toEqual(expected);
      expect(payUnder(3)).toEqual(expected);
    });
});

describe('hollow-ascension: determinism', () => {
  it('advances no substream cursor across an onMerge dispatch', () => {
    const before = bench.streams.snapshotCursors();

    dispatchMerge(bench, mergeCase().payload);

    expectNoDraw(before, bench.streams.snapshotCursors());
  });

  it('advances no substream cursor across a paying onMerge dispatch', () => {
    dispatchMerge(bench, mergeCase().payload);

    const before = bench.streams.snapshotCursors();
    const resolved = dispatchMerge(bench, mergeCase().payload);

    expect(resolved?.scoreDelta).toBe(PRODUCED_VALUE + bonusFor(1));
    expectNoDraw(before, bench.streams.snapshotCursors());
  });

  it('advances no substream cursor across an onStageEnd dispatch that ' +
    'empties the bank', () => {
    dispatchMerge(bench, mergeCase().payload);

    const before = bench.streams.snapshotCursors();

    dispatchStageEnd(bench, stageEnd(false));

    expect(bankOf(bench)).toBe(0);
    expectNoDraw(before, bench.streams.snapshotCursors());
  });

  it('advances no substream cursor across an onStageEnd dispatch that ' +
    'preserves the bank', () => {
    dispatchMerge(bench, mergeCase().payload);

    const before = bench.streams.snapshotCursors();

    dispatchStageEnd(bench, stageEnd(true));

    expect(bankOf(bench)).toBe(1);
    expectNoDraw(before, bench.streams.snapshotCursors());
  });

  it('leaves every cursor at zero across a whole stage', () => {
    const opening = bench.streams.snapshotCursors();

    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase().payload);
    dispatchMerge(bench, mergeCase(Number.NaN).payload);
    dispatchStageEnd(bench, stageEnd(true));
    dispatchMerge(bench, mergeCase().payload);
    dispatchStageEnd(bench, stageEnd(false));

    const closing = bench.streams.snapshotCursors();

    expectNoDraw(opening, closing);

    for (const name of RNG_STREAM_NAMES) {
      expect(closing[name], `${name} cursor`).toBe(0);
    }
  });

  it('produces the same amounts under two different run seeds', () => {
    /** Runs a fixed sequence against a bench built on `seed`. */
    const runUnder = (seed: string): unknown => {
      const target: Bench = {
        ...createBench(),
        streams: createRngStreams(seed),
      };
      const paid: (number | undefined)[] = [];

      for (let index = 0; index < 3; index += 1) {
        const resolved = dispatchMerge(target, mergeCase().payload);

        paid.push(resolved === undefined ? undefined : resolved.scoreDelta);
      }

      const banked = bankOf(target);

      dispatchStageEnd(target, stageEnd(false));

      return { paid, banked, emptied: bankOf(target) };
    };

    const expected = {
      paid: [
        undefined,
        PRODUCED_VALUE + bonusFor(1),
        PRODUCED_VALUE + bonusFor(2),
      ],
      banked: 3,
      emptied: 0,
    };

    expect(runUnder('seed-one')).toEqual(expected);
    expect(runUnder('seed-two')).toEqual(expected);
  });
});

describe('hollow-ascension: handler discipline', () => {
  /** Tokens neither bound handler's source may contain. */
  const forbidden: readonly string[] = [
    'charges',
    'Math.random',
    'catch',
    'console',
    'localStorage',
    'document',
    'Date.now',
  ];

  it('reads no forbidden global or field in either handler source', () => {
    const sources = Object.entries(RELIC.hooks).map(
      ([name, handler]) => [name, String(handler)] as const,
    );

    expect(sources).toHaveLength(2);

    for (const [name, source] of sources) {
      expect(source.length, `${name} source read`).toBeGreaterThan(0);

      for (const token of forbidden) {
        expect(source, `${name} contains ${token}`).not.toContain(token);
      }
    }
  });

  it('reads the state slot and the two payload members it acts on', () => {
    // The corpus check for the scan above: a source read as an empty string
    // would satisfy every exclusion, so the members the handlers DO touch are
    // asserted present.
    expect(String(requireMergeHandler())).toContain('context.state');
    expect(String(requireMergeHandler())).toContain('scoreDelta');
    expect(String(requireStageEndHandler())).toContain('context.state');
    expect(String(requireStageEndHandler())).toContain('cleared');
  });
});

describe('hollow-ascension: the dispatch identity', () => {
  it('runs against a context carrying the run correlation identifier', () => {
    for (const hook of BOUND_HOOKS) {
      const context = contextFor(bench, hook);

      expect(context.correlationId, `${hook} correlation`).toBe(
        SUITE_CORRELATION_ID,
      );
      expect(typeof context.correlationId).toBe('string');
      expect(context.correlationId.length).toBeGreaterThan(0);
      expect(context.hook).toBe(hook);
      expect(context.subscriberId).toBe(RELIC_ID);
      expect(context.pickupOrder).toBe(SUITE_PICKUP_ORDER);
    }
  });

  it('writes its bank on the very context that carries the identifier', () => {
    const context = contextFor(bench, 'onMerge');

    requireMergeHandler()(mergeCase().payload, context);

    // The slot moved on the object that carried the identifier, so the handler
    // ran against that context and no other.
    expect(context.state).toBe(bankAfter(0));
    expect(context.correlationId).toBe(SUITE_CORRELATION_ID);
  });

  it('lets a failure surface instead of catching it', () => {
    /** A merge whose contribution throws the moment it is read. */
    const throwingPayload: MergePayload = {
      ...mergeCase().payload,
      get scoreDelta(): number {
        throw new Error('scoreDelta read');
      },
    };

    expect(() => dispatchMerge(bench, throwingPayload)).toThrow(
      'scoreDelta read',
    );

    // The handler had already written its slot when the read failed, and this
    // bench copies the slot back only on a return, which is the transaction
    // src/engine/hook-bus.ts describes: a handler that throws leaves nothing.
    expect(bankOf(bench)).toBe(0);
  });

  it('resumes normally after a dispatch that failed', () => {
    const throwingPayload: MergePayload = {
      ...mergeCase().payload,
      get scoreDelta(): number {
        throw new Error('scoreDelta read');
      },
    };

    expect(() => dispatchMerge(bench, throwingPayload)).toThrow();

    dispatchMerge(bench, mergeCase().payload);

    const resolved = dispatchMerge(bench, mergeCase().payload);

    expect(resolved?.scoreDelta).toBe(PRODUCED_VALUE + bonusFor(1));
    expect(bankOf(bench)).toBe(2);

    dispatchStageEnd(bench, stageEnd(false));

    expect(bankOf(bench)).toBe(0);
  });
});

describe('hollow-ascension: the declaration this suite read', () => {
  it('is frozen at every level the family module owns', () => {
    expect(Object.isFrozen(RELIC)).toBe(true);
    expect(Object.isFrozen(RELIC.hooks)).toBe(true);
    expect(Object.isFrozen(RISK_REWARD_CURSED_FAMILY)).toBe(true);
    expect(Object.isFrozen(RISK_REWARD_CURSED_FAMILY.relics)).toBe(true);
  });

  it('stands exactly as it stood when this file was loaded', () => {
    expect({
      id: RELIC.id,
      name: RELIC.name,
      rarity: RELIC.rarity,
      description: RELIC.description,
      hookNames: [...Object.keys(RELIC.hooks)].sort(),
      onMerge: RELIC.hooks.onMerge,
      onStageEnd: RELIC.hooks.onStageEnd,
      charges: RELIC.charges,
      state: RELIC.state,
    }).toEqual({
      id: DECLARATION_AT_LOAD.id,
      name: DECLARATION_AT_LOAD.name,
      rarity: DECLARATION_AT_LOAD.rarity,
      description: DECLARATION_AT_LOAD.description,
      hookNames: [...DECLARATION_AT_LOAD.hookNames],
      onMerge: DECLARATION_AT_LOAD.onMerge,
      onStageEnd: DECLARATION_AT_LOAD.onStageEnd,
      charges: DECLARATION_AT_LOAD.charges,
      state: DECLARATION_AT_LOAD.state,
    });

    // The declared opening bank in particular: every dispatch above wrote a
    // slot carried on a context, and none of them may have reached this.
    expect(RELIC.state).toBe(0);
  });

  it('holds its ordinal position in the family, which the draw resolves ' +
    'against', () => {
    expect(RISK_REWARD_CURSED_FAMILY.relics).toHaveLength(4);
    expect(RISK_REWARD_CURSED_FAMILY.relics[3]).toBe(RELIC);
    expect(RISK_REWARD_CURSED_FAMILY.relics.map((relic) => relic.id)).toEqual([
      'collapsing-vault',
      'gilded-rot',
      'brittle-crown',
      RELIC_ID,
    ]);
  });
});
