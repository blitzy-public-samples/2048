// Isolation suite for the `brittle-crown` relic of the `risk-reward-cursed`
// family: AAP R3, AAP Contract 2 and AAP Contract 5, one relic per file.
//
// The three properties AAP 0.6.3 Group 5 states, in its order: the relic fires
// only on the hooks it binds, it produces its specified effect, and it respects
// `charges` — a dispatch carrying zero of them included.
//
// The specified effect has two halves separated by a whole stage.
// `onStageStart` saves the spawn distribution in force and installs a skewed
// one; `onStageEnd` restores the saved distribution and releases the slot. The
// saved value travels between the two halves in the subscriber state slot,
// which is the one channel that survives a reload.
//
// Provenance of the numbers asserted below:
//   js/game_manager.js L71             `Math.random() < 0.9 ? 2 : 4`, the
//                                      vanilla distribution the default rules
//                                      carry as values [2, 4] at weights
//                                      [0.9, 0.1], now `RulesConfig.spawn`
//   js/local_storage_manager.js L52-55 `getGameState()` read the snapshot
//                                      through an unguarded `JSON.parse`, and
//                                      the snapshot carried no version and no
//                                      checksum field. Every value this relic
//                                      persists is plain JSON
//   AAP Contract 5                     the persisted relic triple
//                                      `{ id, charges?, state? }`, which is
//                                      what carries the saved weights across a
//                                      reload
//
// Traceability rows this suite evidences: TR-DEFAULT-04, js/game_manager.js L71
// onto `RulesConfig.spawn`; and TR-RISK-03, `brittle-crown` at `onStageStart`
// and `onStageEnd`. The decision behind the write channel the relic records
// through, named so the construct can be found from docs/DECISION_LOG.md:
// DL-RISK-02.
//
// Named figures this suite is a mechanical proof of: Figure 6, "Screen Flow
// State Machine: Run Start to Run Summary", of docs/architecture/, whose
// Stage -> StageClear -> Reward -> Stage cycle is the exact span these two
// hooks bracket; and Figure 7, "Seeded Determinism: One Run Seed Fanned into
// Named RNG Substreams", of docs/architecture/data-flow.md, whose `spawn-value`
// edge consumes the weights this relic skews.
//
// The dispatch below is hand-built. The charge guard, the pickup ordering and
// the per-handler transaction belong to src/engine/hook-bus.ts and are asserted
// over the real bus by the suites of tests/unit/engine, and are not re-proved
// here. The context assembled below carries the run correlation identifier,
// every collaborator as the frozen view src/engine/hooks.ts declares, and a
// state slot copied in and out as JSON.
//
// No DOM, no clock, no timer, no `Math.random()` and no snapshot file: this
// suite runs in the `unit:dom-free` project under the `test` script with no
// server, browser or network.

import { beforeEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import {
  createDefaultStageConfig,
  stageGoalForIndex,
} from '../../../src/config/stage-config';
import { Grid } from '../../../src/engine/grid';
import { HOOK_NAMES } from '../../../src/engine/hooks';
import type {
  BoardEffect,
  BoardEffectQueue,
  HookContext,
  HookHandler,
  HookName,
  ReadonlyGridView,
  ReadonlyRngView,
  ReadonlyRulesView,
  StageEndPayload,
  StageStartPayload,
} from '../../../src/engine/hooks';
import type { CorrelationId, Position } from '../../../src/engine/types';
import {
  RISK_REWARD_CURSED_FAMILY,
} from '../../../src/relics/families/risk-reward-cursed';
import { findRelicById } from '../../../src/relics/relic-registry';
import { RARITIES } from '../../../src/relics/relic-types';
import type { Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type {
  RngCursorMap,
  RngStream,
  RngStreams,
  StreamName,
} from '../../../src/rng/rng-streams';
import { createMergePairBoard } from '../../fixtures/boards';

/* ==========================================================================
 * Constants
 * ========================================================================== */

/** Id of the unit under test, as the family declares it. */
const RELIC_ID = 'brittle-crown';

/** Family that declares it, hyphenated as `RelicFamilyName` spells it. */
const FAMILY_NAME = 'risk-reward-cursed';

/** The two hooks the relic binds, in `HOOK_NAMES` order. */
const BOUND_HOOKS: readonly HookName[] = ['onStageStart', 'onStageEnd'];

/** The four hooks the relic leaves absent, in `HOOK_NAMES` order. */
const UNBOUND_HOOKS: readonly HookName[] = [
  'onBeforeMove',
  'onMerge',
  'onSpawn',
  'onAfterMove',
];

/**
 * Seed every context in this suite is built from, as a literal: no clock and no
 * `Math.random()` reaches this file.
 */
const SUITE_SEED = 'brittle-crown-spawn-skew';

/** Run correlation identifier the assembled context carries. */
const RUN_CORRELATION_ID: CorrelationId = 'run-brittle-crown-suite';

/** Pickup position the assembled context carries. */
const PICKUP_ORDER = 1;

/** Spawn values the default rules carry. From js/game_manager.js L71. */
const VANILLA_SPAWN_VALUES: readonly number[] = [2, 4];

/** Spawn weights the default rules carry. From the same expression. */
const VANILLA_SPAWN_WEIGHTS: readonly number[] = [0.9, 0.1];

/**
 * Distribution the relic installs over the vanilla one: the weight of 4, the
 * highest configured value, four times over, and the weight of 2 as it stood.
 * `0.1 * 4 === 0.4` exactly in IEEE-754 double arithmetic.
 */
const SKEWED_SPAWN_WEIGHTS: readonly number[] = [0.9, 0.4];

/** Factor the relic raises the highest value weight by. */
const SPAWN_SKEW_FACTOR = 4;

/** Divisor of the score the relic pays as a bounty for a cleared stage. */
const CLEAR_BOUNTY_DIVISOR = 4;

/** A cleared stage score that pays a whole-point bounty. */
const BOUNTY_SCORE = 400;

/** The score that stage pays out at. */
const BOUNTY_PAID_SCORE = 500;

/** A cleared stage score whose quarter floors to nothing. */
const UNPAYABLE_SCORE = 3;

/** Weight written in place to prove a saved copy aliases no live array. */
const SENTINEL_WEIGHT = 0.123456;

/** Values of a three-entry distribution the relic reads at use time. */
const WIDE_SPAWN_VALUES: readonly number[] = [2, 4, 8];

/** Weights of that distribution. */
const WIDE_SPAWN_WEIGHTS: readonly number[] = [0.5, 0.3, 0.2];

/** The distribution the relic installs over it: 0.2 raised fourfold. */
const WIDE_SKEWED_WEIGHTS: readonly number[] = [0.5, 0.3, 0.8];

/** Draws taken from each substream in the spawn-outcome comparison. */
const DRAW_SAMPLE_SIZE = 24;

/** Highest-value draws the vanilla distribution yields over that sample. */
const VANILLA_HIGHEST_DRAWS = 6;

/** Highest-value draws the skewed distribution yields over that sample. */
const SKEWED_HIGHEST_DRAWS = 12;

/** Board size the default rules carry, and the fixture board edge length. */
const BOARD_SIZE = 4;

/** Win value the default rules carry. From js/game_manager.js L170. */
const WIN_VALUE = 2048;

/** Opening tile count the default rules carry. From js/game_manager.js L7. */
const START_TILES = 2;

/* ==========================================================================
 * The declaration under test
 * ========================================================================== */

/**
 * Reaches the relic through the family that declares it.
 *
 * @returns The `brittle-crown` declaration.
 * @throws {Error} If the family declares no relic under that id, which is what
 *   a rename of the id fails on rather than passing silently.
 */
function declaredCrown(): Relic {
  const found = RISK_REWARD_CURSED_FAMILY.relics.find(
    (relic) => relic.id === RELIC_ID,
  );

  if (found === undefined) {
    throw new Error(
      `The ${FAMILY_NAME} family declares no relic with the id ${RELIC_ID}.`,
    );
  }

  return found;
}

const CROWN: Relic = declaredCrown();

/**
 * The declaration as this file loaded it, member by member, so the closing
 * section can compare the catalogue object against it.
 */
const CROWN_AT_LOAD = Object.freeze({
  id: CROWN.id,
  name: CROWN.name,
  rarity: CROWN.rarity,
  description: CROWN.description,
  hookNames: Object.freeze(Object.keys(CROWN.hooks)),
  onStageStart: CROWN.hooks.onStageStart,
  onStageEnd: CROWN.hooks.onStageEnd,
  declaresCharges: 'charges' in CROWN,
  state: JSON.stringify(CROWN.state),
});

/**
 * The handler bound to `onStageStart`.
 *
 * @returns The handler the declaration carries.
 * @throws {Error} If the binding is absent.
 */
function stageStartHandler(): HookHandler<'onStageStart'> {
  const handler = CROWN.hooks.onStageStart;

  if (handler === undefined) {
    throw new Error(`${RELIC_ID} binds no onStageStart handler.`);
  }

  return handler;
}

/**
 * The handler bound to `onStageEnd`.
 *
 * @returns The handler the declaration carries.
 * @throws {Error} If the binding is absent.
 */
function stageEndHandler(): HookHandler<'onStageEnd'> {
  const handler = CROWN.hooks.onStageEnd;

  if (handler === undefined) {
    throw new Error(`${RELIC_ID} binds no onStageEnd handler.`);
  }

  return handler;
}

/** Both bound handlers as source text, for the machinery assertions. */
function handlerSources(): readonly string[] {
  return [stageStartHandler().toString(), stageEndHandler().toString()];
}

/* ==========================================================================
 * Harness: the collaborators one dispatch is handed
 * ========================================================================== */

/**
 * Reports whether a value can be read by member name: an object that is neither
 * `null` nor an array, which is the shape a JSON state slot round-trips as.
 *
 * @param value Candidate value.
 * @returns `true` when the value can be read by member name.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copies a value the way src/engine/hook-bus.ts copies a state slot and the way
 * the run envelope of src/run/run-state.ts persists one: through JSON. Anything
 * JSON drops — a function, a symbol, a `bigint` member — does not survive.
 *
 * @param value Value to copy.
 * @returns A fresh value sharing no object with the argument.
 */
function copyJson(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  const encoded = JSON.stringify(value);

  return encoded === undefined ? undefined : JSON.parse(encoded);
}

/**
 * Reads the `savedWeights` member a state slot holds, so an assertion names the
 * saved array rather than the slot around it.
 *
 * @param slot The slot as it stands.
 * @returns The member, or `undefined` where the slot holds none.
 */
function savedWeightsOf(slot: unknown): unknown {
  return isRecord(slot) ? slot.savedWeights : undefined;
}

/**
 * Reports whether a weight list is one `RngStream.pickWeighted` can resolve
 * against: one weight per configured value, every entry a finite number at or
 * above zero, and at least one above zero. The acceptance rule
 * src/engine/board-effects.ts documents for `setSpawnWeights`.
 *
 * @param valueCount How many spawn values the rules carry.
 * @param weights Weight list to judge.
 * @returns `true` when a draw can resolve against the list.
 */
function isDrawableDistribution(
  valueCount: number,
  weights: readonly number[],
): boolean {
  if (valueCount === 0 || weights.length !== valueCount) {
    return false;
  }

  let total = 0;

  for (const weight of weights) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      return false;
    }

    total += weight;
  }

  return total > 0;
}

/** The live collaborators one stage cycle is dispatched against. */
interface CrownBench {
  /** The live, mutable rules a dispatch reads and a command writes. */
  readonly config: RulesConfig;

  /** The four real substreams of the run. */
  readonly streams: RngStreams;

  /** The live board. */
  readonly grid: Grid;

  /** The subscriber state slot, as src/engine/hook-bus.ts would hold it. */
  slot: unknown;
}

/**
 * Builds a bench: default rules, the suite seed, the merge-pair fixture board
 * and the opening state slot the declaration carries.
 *
 * `createDefaultRulesConfig()` and not `DEFAULT_RULES_CONFIG`: the deep-frozen
 * template refuses the spawn-weight write this relic drives.
 *
 * @returns A bench sharing no object with any earlier one.
 */
function createBench(): CrownBench {
  const board = createMergePairBoard();

  return {
    config: createDefaultRulesConfig(),
    streams: createRngStreams(SUITE_SEED),
    grid: new Grid(board.grid.size, board.grid.cells),
    slot: copyJson(CROWN.state),
  };
}

/**
 * The rules a handler reads: a frozen view whose members read the live config
 * at call time, as src/engine/hook-bus.ts builds it.
 *
 * @param config The live rules.
 * @returns The frozen read-only projection.
 */
function rulesView(config: RulesConfig): ReadonlyRulesView {
  const view: ReadonlyRulesView = {
    get boardSize(): number {
      return config.boardSize;
    },

    get winValue(): number {
      return config.winValue;
    },

    get startTiles(): number {
      return config.startTiles;
    },

    spawn: Object.freeze({
      get values(): readonly number[] {
        return config.spawn.values;
      },

      get weights(): readonly number[] {
        return config.spawn.weights;
      },
    }),

    merge: Object.freeze({
      get canMerge(): RulesConfig['merge']['canMerge'] {
        return config.merge.canMerge;
      },

      get produce(): RulesConfig['merge']['produce'] {
        return config.merge.produce;
      },
    }),
  };

  return Object.freeze(view);
}

/**
 * The board a handler reads: the query half of `Grid` and none of its writes.
 *
 * @param grid The live board.
 * @returns The frozen read-only facade.
 */
function gridView(grid: Grid): ReadonlyGridView {
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

/** A randomness view plus the count of substreams addressed through it. */
interface RngProbe {
  /** The view handed to the handler. */
  readonly view: ReadonlyRngView;

  /** How many times a substream was addressed. */
  readonly requests: () => number;
}

/**
 * The randomness a handler draws from: memoised forks of the run substreams, so
 * a draw taken here moves the fork and never the run.
 *
 * @param streams The run substreams.
 * @returns The view and its request counter.
 */
function openRng(streams: RngStreams): RngProbe {
  const forks = new Map<StreamName, RngStream>();
  let requests = 0;

  const view: ReadonlyRngView = {
    seed: streams.seed,

    stream: (name) => {
      requests += 1;

      const held = forks.get(name);

      if (held !== undefined) {
        return held;
      }

      const opened = streams.stream(name).fork();

      forks.set(name, opened);

      return opened;
    },

    snapshotCursors: (): RngCursorMap => {
      const cursors = streams.snapshotCursors();

      for (const name of RNG_STREAM_NAMES) {
        const fork = forks.get(name);

        if (fork !== undefined) {
          cursors[name] = fork.cursor;
        }
      }

      return cursors;
    },
  };

  return { view: Object.freeze(view), requests: () => requests };
}

/** A board-effect queue plus what was recorded and refused through it. */
interface QueueProbe {
  /** The queue handed to the handler. */
  readonly queue: BoardEffectQueue;

  /** Commands recorded, in record order. */
  readonly recorded: BoardEffect[];

  /** Commands refused. */
  readonly refused: () => number;
}

/**
 * Opens a recording queue over a bench: every command of
 * `BOARD_EFFECT_NAMES` is accepted, validated and recorded, and nothing is
 * written through to the board. The five query members read the live board,
 * which this relic records no lattice command against.
 *
 * @param bench The bench the queue projects from.
 * @returns The queue and its record.
 */
function openQueue(bench: CrownBench): QueueProbe {
  const grid = bench.grid;
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

  const insertTile = (cell: Position, value: number): boolean =>
    grid.withinBounds(cell) &&
    grid.cellAvailable(cell) &&
    Number.isSafeInteger(value) &&
    value > 0
      ? record({ kind: 'insertTile', cell, value })
      : refuse();

  const removeTile = (cell: Position): boolean =>
    grid.cellOccupied(cell) ? record({ kind: 'removeTile', cell }) : refuse();

  const moveTile = (from: Position, to: Position, tween = true): boolean =>
    grid.cellOccupied(from) && grid.cellAvailable(to) && grid.withinBounds(to)
      ? record({ kind: 'moveTile', from, to, tween })
      : refuse();

  const restoreBoard = (
    snapshot: ReturnType<Grid['serialize']>,
    score?: number,
  ): boolean =>
    isRecord(snapshot)
      ? record({ kind: 'restoreBoard', snapshot, score })
      : refuse();

  const resizeBoard = (size: number): boolean =>
    Number.isSafeInteger(size) && size > 0
      ? record({ kind: 'resizeBoard', size })
      : refuse();

  const setMergePredicate = (
    predicate: RulesConfig['merge']['canMerge'],
  ): boolean =>
    typeof predicate === 'function'
      ? record({ kind: 'setMergePredicate', predicate })
      : refuse();

  const setSpawnWeights = (weights: readonly number[]): boolean =>
    isDrawableDistribution(bench.config.spawn.values.length, weights)
      ? record({ kind: 'setSpawnWeights', weights: [...weights] })
      : refuse();

  const queue: BoardEffectQueue = {
    get size(): number {
      return grid.size;
    },

    get length(): number {
      return recorded.length;
    },

    get refused(): number {
      return refused;
    },

    insertTile,
    removeTile,
    moveTile,
    restoreBoard,
    resizeBoard,
    setMergePredicate,
    setSpawnWeights,

    request: (effect) => {
      switch (effect.kind) {
        case 'insertTile':
          return insertTile(effect.cell, effect.value);
        case 'removeTile':
          return removeTile(effect.cell);
        case 'moveTile':
          return moveTile(effect.from, effect.to, effect.tween ?? true);
        case 'restoreBoard': {
          const snapshot = effect.snapshot ?? effect.board;

          return snapshot === undefined
            ? refuse()
            : restoreBoard(snapshot, effect.score);
        }
        case 'resizeBoard': {
          const size = effect.size ?? effect.boardSize;

          return size === undefined ? refuse() : resizeBoard(size);
        }
        case 'setMergePredicate':
          return setMergePredicate(effect.predicate);
        case 'setSpawnWeights':
          return setSpawnWeights(effect.weights);
        default:
          return refuse();
      }
    },

    requested: () => Object.freeze([...recorded]),
    cellValue: (cell) => grid.cellContent(cell)?.value ?? null,
    cellOccupied: (cell) => grid.cellOccupied(cell),
    availableCells: () => grid.availableCells(),

    occupiedCells: () => {
      const cells: { x: number; y: number; value: number }[] = [];

      grid.eachCell((x, y, tile) => {
        if (tile !== null) {
          cells.push({ x, y, value: tile.value });
        }
      });

      return cells;
    },

    clear: () => {
      recorded.length = 0;
    },
  };

  return {
    queue: Object.freeze(queue),
    recorded,
    refused: () => refused,
  };
}

/**
 * Writes every recorded spawn-weight command to the live rules, in record
 * order and as a fresh array, which is what src/engine/hook-bus.ts commits once
 * a handler has returned and its return has validated.
 *
 * @param config The live rules.
 * @param commands The commands recorded by one dispatch.
 * @returns How many spawn-weight commands were written.
 */
function applySpawnWeights(
  config: RulesConfig,
  commands: readonly BoardEffect[],
): number {
  let applied = 0;

  for (const command of commands) {
    if (command.kind !== 'setSpawnWeights') {
      continue;
    }

    config.spawn.weights = [...command.weights];
    applied += 1;
  }

  return applied;
}

/* ==========================================================================
 * Harness: one hand-built dispatch
 * ========================================================================== */

/** The context handed to one handler, with the probes that watched it. */
interface ContextBuild {
  readonly context: HookContext;
  readonly probe: QueueProbe;
  readonly rng: RngProbe;

  /** The slot as it ARRIVED, copied before the handler ran. */
  readonly arrived: unknown;

  /** Charges the handler asked the bus to spend. */
  readonly chargeRequests: () => number;
}

/**
 * Assembles one `HookContext` exactly as src/engine/hooks.ts declares it: the
 * three frozen collaborator views, the recording write channel, the run
 * correlation identifier, the dispatch identity, the charge budget the bus
 * would have carried, and a state slot that is a COPY of the bench slot.
 *
 * @param bench The live collaborators.
 * @param hook The hook being dispatched.
 * @param charges The budget the subscription carries, absent for none.
 * @returns The context and its probes.
 */
function buildContext(
  bench: CrownBench,
  hook: HookName,
  charges: number | undefined,
): ContextBuild {
  const probe = openQueue(bench);
  const rng = openRng(bench.streams);
  const arrived = copyJson(bench.slot);
  let chargeRequests = 0;

  const context: HookContext = {
    config: rulesView(bench.config),
    rng: rng.view,
    grid: gridView(bench.grid),
    effects: probe.queue,
    correlationId: RUN_CORRELATION_ID,
    hook,
    subscriberId: RELIC_ID,
    pickupOrder: PICKUP_ORDER,
    charges,

    spendCharge: (amount = 1) => {
      chargeRequests += amount;

      return false;
    },

    state: copyJson(bench.slot),
  };

  return {
    context,
    probe,
    rng,
    arrived,
    chargeRequests: () => chargeRequests,
  };
}

/** Everything one dispatch produced, observed rather than inferred. */
interface DispatchRecord<P> {
  /** The payload returned, and `undefined` where the handler returned none. */
  readonly returned: P | undefined;

  /** The context the handler was given, read after it returned. */
  readonly context: HookContext;

  /** The slot as it arrived, before the handler ran. */
  readonly arrived: unknown;

  /** Commands recorded, in record order. */
  readonly recorded: readonly BoardEffect[];

  /** Commands the queue refused. */
  readonly refused: number;

  /** Charges the handler asked the bus to spend. */
  readonly chargeRequests: number;

  /** Spawn-weight commands written through to the live rules. */
  readonly applied: number;

  /** Substreams the handler addressed on its context. */
  readonly streamRequests: number;

  /** Run cursor map read immediately before the dispatch. */
  readonly cursorsBefore: RngCursorMap;

  /** Run cursor map read immediately after it. */
  readonly cursorsAfter: RngCursorMap;
}

/**
 * Resolves one dispatch the way the bus resolves an accepted one: the recorded
 * commands are written to the rules, and the slot the handler left is copied
 * back onto the subscriber.
 *
 * @param bench The live collaborators.
 * @param built The context that was dispatched against.
 * @param produced Whatever the handler returned.
 * @param cursorsBefore Run cursors read before the dispatch.
 * @param cursorsAfter Run cursors read after it.
 * @returns The full record of the dispatch.
 */
function settle<P>(
  bench: CrownBench,
  built: ContextBuild,
  produced: P | void,
  cursorsBefore: RngCursorMap,
  cursorsAfter: RngCursorMap,
): DispatchRecord<P> {
  const applied = applySpawnWeights(bench.config, built.probe.recorded);

  bench.slot = copyJson(built.context.state);

  return {
    returned: produced === undefined ? undefined : produced,
    context: built.context,
    arrived: built.arrived,
    recorded: [...built.probe.recorded],
    refused: built.probe.refused(),
    chargeRequests: built.chargeRequests(),
    applied,
    streamRequests: built.rng.requests(),
    cursorsBefore,
    cursorsAfter,
  };
}

/**
 * The `onStageStart` payload, with the stage goal taken from the default
 * progression curve rather than written as a literal.
 *
 * @param boardSize Edge length the stage grid was built at.
 * @param stageIndex Zero-based stage position.
 * @returns A fresh payload.
 */
function stageStartPayload(
  boardSize: number,
  stageIndex = 0,
): StageStartPayload {
  return {
    stageIndex,
    goal: stageGoalForIndex(stageIndex, createDefaultStageConfig()),
    seed: SUITE_SEED,
    boardSize,
  };
}

/**
 * The `onStageEnd` payload.
 *
 * @param cleared Whether the stage goal was met.
 * @param score Score the stage resolved at.
 * @returns A fresh payload.
 */
function stageEndPayload(
  cleared: boolean,
  score = BOUNTY_SCORE,
): StageEndPayload {
  return { stageIndex: 0, cleared, score };
}

/**
 * Dispatches `onStageStart` against a bench.
 *
 * @param bench The live collaborators.
 * @param payload Payload to dispatch, defaulting to stage zero of the bench.
 * @param charges Budget the subscription carries, absent for none.
 * @returns The full record of the dispatch.
 */
function startStage(
  bench: CrownBench,
  payload?: StageStartPayload,
  charges?: number,
): DispatchRecord<StageStartPayload> {
  const resolved = payload ?? stageStartPayload(bench.grid.size);
  const built = buildContext(bench, 'onStageStart', charges);
  const before = bench.streams.snapshotCursors();
  const produced = stageStartHandler()(resolved, built.context);
  const after = bench.streams.snapshotCursors();

  return settle(bench, built, produced, before, after);
}

/**
 * Dispatches `onStageEnd` against a bench.
 *
 * @param bench The live collaborators.
 * @param payload Payload to dispatch, defaulting to a cleared stage.
 * @param charges Budget the subscription carries, absent for none.
 * @returns The full record of the dispatch.
 */
function endStage(
  bench: CrownBench,
  payload?: StageEndPayload,
  charges?: number,
): DispatchRecord<StageEndPayload> {
  const resolved = payload ?? stageEndPayload(true);
  const built = buildContext(bench, 'onStageEnd', charges);
  const before = bench.streams.snapshotCursors();
  const produced = stageEndHandler()(resolved, built.context);
  const after = bench.streams.snapshotCursors();

  return settle(bench, built, produced, before, after);
}

/**
 * Narrows a dispatch that must have returned a payload.
 *
 * @param record The dispatch.
 * @returns The payload it returned.
 * @throws {Error} If it returned none.
 */
function payloadOf<P>(record: DispatchRecord<P>): P {
  const returned = record.returned;

  if (returned === undefined) {
    throw new Error(
      `The ${record.context.hook} handler of ${RELIC_ID} returned no payload.`,
    );
  }

  return returned;
}

/**
 * Asserts the live distribution is one a spawn draw can resolve against: one
 * weight per configured value, every entry finite and at or above zero, and at
 * least one above zero.
 *
 * @param config The live rules.
 */
function expectDrawableDistribution(config: RulesConfig): void {
  const weights = config.spawn.weights;

  expect(weights).toHaveLength(config.spawn.values.length);
  expect(weights.length).toBeGreaterThan(0);

  for (const weight of weights) {
    expect(Number.isFinite(weight)).toBe(true);
    expect(weight).toBeGreaterThanOrEqual(0);
  }

  expect(weights.some((weight) => weight > 0)).toBe(true);
}

/**
 * Asserts a state slot is whole: either empty, or carrying one complete array
 * of finite non-negative saved weights. A slot in any other shape is a
 * half-written save.
 *
 * @param slot The slot as it stands.
 */
function expectWholeSlot(slot: unknown): void {
  expect(isRecord(slot)).toBe(true);

  const saved = savedWeightsOf(slot);

  if (saved === undefined) {
    expect(slot).toEqual({});

    return;
  }

  expect(Array.isArray(saved)).toBe(true);
  expect(Object.keys(slot as Record<string, unknown>)).toEqual([
    'savedWeights',
  ]);

  const weights = saved as readonly number[];

  expect(isDrawableDistribution(weights.length, weights)).toBe(true);
}

/**
 * Draws a fixed sample from the `spawn-value` substream of a run seeded with
 * the suite seed, resolving each draw against one distribution.
 *
 * @param values Spawn values to draw from.
 * @param weights Distribution to resolve against.
 * @returns The values drawn, in draw order.
 */
function drawSample(
  values: readonly number[],
  weights: readonly number[],
): number[] {
  const stream = createRngStreams(SUITE_SEED).stream('spawn-value');
  const drawn: number[] = [];

  for (let draw = 0; draw < DRAW_SAMPLE_SIZE; draw += 1) {
    const picked = stream.pickWeighted(values, weights);

    if (picked === undefined) {
      throw new Error('The spawn draw resolved against no value.');
    }

    drawn.push(picked);
  }

  return drawn;
}

/* ==========================================================================
 * The bench each test is given
 * ========================================================================== */

let bench: CrownBench;

beforeEach(() => {
  bench = createBench();
});

/* ==========================================================================
 * 1. The declaration: brittle-crown fires only on the hooks it binds
 * ========================================================================== */

describe('the brittle-crown declaration', () => {
  it('is declared by the risk-reward-cursed family under that exact id', () => {
    expect(RISK_REWARD_CURSED_FAMILY.name).toBe(FAMILY_NAME);
    expect(CROWN.id).toBe(RELIC_ID);
    expect(CROWN.name).toBe('Brittle Crown');
    expect(CROWN.rarity).toBe(RARITIES[2]);
    expect(CROWN.description.length).toBeGreaterThan(0);
  });

  it('is the very object the relic catalogue registers under that id', () => {
    expect(findRelicById(RELIC_ID)).toBe(CROWN);
  });

  it('binds onStageStart and onStageEnd, and no third hook', () => {
    expect(Object.keys(CROWN.hooks)).toEqual(BOUND_HOOKS);
    expect(Object.keys(CROWN.hooks)).toHaveLength(2);

    for (const name of Object.keys(CROWN.hooks)) {
      expect(HOOK_NAMES).toContain(name);
    }
  });

  it('leaves the four hooks it does not act on absent, not undefined', () => {
    for (const name of UNBOUND_HOOKS) {
      expect(name in CROWN.hooks).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(CROWN.hooks, name)).toBe(
        false,
      );
    }

    expect(UNBOUND_HOOKS).toHaveLength(4);
  });

  it('binds no onSpawn handler, rewriting the rules instead', () => {
    expect('onSpawn' in CROWN.hooks).toBe(false);
    expect(CROWN.hooks.onSpawn).toBeUndefined();
  });

  it('binds a callable handler to each of its two hooks', () => {
    expect(typeof CROWN.hooks.onStageStart).toBe('function');
    expect(typeof CROWN.hooks.onStageEnd).toBe('function');
    expect(stageStartHandler()).toBe(CROWN.hooks.onStageStart);
    expect(stageEndHandler()).toBe(CROWN.hooks.onStageEnd);
  });

  it('declares no charge budget, so the field is absent and never null', () => {
    expect('charges' in CROWN).toBe(false);
    expect(CROWN.charges).toBeUndefined();
    expect(CROWN.charges).not.toBeNull();
  });

  it('opens with an empty state slot that is plain JSON', () => {
    expect(CROWN.state).toEqual({});
    expect(JSON.parse(JSON.stringify(CROWN.state))).toEqual({});
  });
});

/* ==========================================================================
 * 2. The skew brittle-crown installs at onStageStart
 * ========================================================================== */

describe('the skew brittle-crown installs at onStageStart', () => {
  it('records one spawn-weight command and returns no payload', () => {
    const started = startStage(bench);

    expect(started.recorded).toHaveLength(1);
    expect(started.recorded[0]?.kind).toBe('setSpawnWeights');
    expect(started.applied).toBe(1);
    expect(started.refused).toBe(0);
    expect(started.returned).toBeUndefined();
  });

  it('is handed the run correlation identifier and its own identity', () => {
    const started = startStage(bench);

    expect(started.context.correlationId).toBe(RUN_CORRELATION_ID);
    expect(started.context.hook).toBe('onStageStart');
    expect(started.context.subscriberId).toBe(RELIC_ID);
    expect(started.context.pickupOrder).toBe(PICKUP_ORDER);
    expect(started.context.rng.seed).toBe(SUITE_SEED);
    expect(endStage(bench).context.hook).toBe('onStageEnd');
  });

  it('quadruples the weight of the highest spawn value alone', () => {
    expect(bench.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);

    startStage(bench);

    expect(bench.config.spawn.weights).toEqual(SKEWED_SPAWN_WEIGHTS);
    expect(bench.config.spawn.weights[1]).toBe(
      (VANILLA_SPAWN_WEIGHTS[1] ?? 0) * SPAWN_SKEW_FACTOR,
    );
    expect(bench.config.spawn.weights[0]).toBe(VANILLA_SPAWN_WEIGHTS[0]);
  });

  it('reads the distribution in force rather than a literal pair', () => {
    bench.config.spawn.values = [...WIDE_SPAWN_VALUES];
    bench.config.spawn.weights = [...WIDE_SPAWN_WEIGHTS];

    startStage(bench);

    expect(bench.config.spawn.weights).toEqual(WIDE_SKEWED_WEIGHTS);
    expect(bench.config.spawn.values).toEqual(WIDE_SPAWN_VALUES);
  });

  it('leaves the spawn values themselves untouched', () => {
    const values = bench.config.spawn.values;

    startStage(bench);

    expect(bench.config.spawn.values).toBe(values);
    expect(bench.config.spawn.values).toEqual(VANILLA_SPAWN_VALUES);
  });

  it('installs a distribution a weighted spawn draw can resolve', () => {
    startStage(bench);

    expectDrawableDistribution(bench.config);
  });

  it('saves a value copy of the spawn weights, never a live reference', () => {
    const live = bench.config.spawn.weights;
    const original = [...live];
    const started = startStage(bench);

    expect(savedWeightsOf(started.context.state)).not.toBe(live);

    live[1] = SENTINEL_WEIGHT;
    bench.config.spawn.weights[1] = SENTINEL_WEIGHT;

    expect(started.context.state).toEqual({ savedWeights: original });
    expect(savedWeightsOf(started.context.state)).toEqual(
      VANILLA_SPAWN_WEIGHTS,
    );
  });

  it('carries that saved copy onto the subscriber slot', () => {
    const started = startStage(bench);

    expect(started.context.state).toEqual({
      savedWeights: [...VANILLA_SPAWN_WEIGHTS],
    });
    expect(bench.slot).toEqual({ savedWeights: [...VANILLA_SPAWN_WEIGHTS] });
    expectWholeSlot(bench.slot);
  });

  it('keeps the true pre-relic weights when a stage starts twice', () => {
    startStage(bench);

    const installed = [...bench.config.spawn.weights];

    startStage(bench);

    expect(bench.config.spawn.weights).toEqual(installed);
    expect(bench.config.spawn.weights).toEqual(SKEWED_SPAWN_WEIGHTS);
    expect(bench.slot).toEqual({ savedWeights: [...VANILLA_SPAWN_WEIGHTS] });
  });

  it('changes no rule other than the spawn weights', () => {
    const spawn = bench.config.spawn;
    const merge = bench.config.merge;
    const canMerge = merge.canMerge;
    const produce = merge.produce;

    startStage(bench);

    expect(bench.config.boardSize).toBe(BOARD_SIZE);
    expect(bench.config.winValue).toBe(WIN_VALUE);
    expect(bench.config.startTiles).toBe(START_TILES);
    expect(bench.config.spawn).toBe(spawn);
    expect(bench.config.merge).toBe(merge);
    expect(bench.config.merge.canMerge).toBe(canMerge);
    expect(bench.config.merge.produce).toBe(produce);
  });

  it('leaves the payload it was handed exactly as it arrived', () => {
    const payload = stageStartPayload(bench.grid.size, 2);
    const goal = payload.goal;

    startStage(bench, payload);

    expect(payload.stageIndex).toBe(2);
    expect(payload.goal).toBe(goal);
    expect(payload.seed).toBe(SUITE_SEED);
    expect(payload.boardSize).toBe(BOARD_SIZE);
  });

  it('leaves the board it was handed exactly as it arrived', () => {
    const before = JSON.stringify(bench.grid.serialize());

    startStage(bench);

    expect(JSON.stringify(bench.grid.serialize())).toBe(before);
    expect(bench.grid.size).toBe(BOARD_SIZE);
  });

  it('records no board command beyond the spawn-weight substitution', () => {
    const started = startStage(bench);

    for (const command of started.recorded) {
      expect(command.kind).toBe('setSpawnWeights');
    }
  });
});

/* ==========================================================================
 * 3. The restore brittle-crown performs at onStageEnd
 * ========================================================================== */

describe('the restore brittle-crown performs at onStageEnd', () => {
  it('restores the exact original weights, element by element', () => {
    const original = [...bench.config.spawn.weights];

    startStage(bench);

    expect(bench.config.spawn.weights).toEqual(SKEWED_SPAWN_WEIGHTS);

    endStage(bench);

    const restored = bench.config.spawn.weights;

    expect(restored).toHaveLength(original.length);

    original.forEach((weight, index) => {
      expect(restored[index]).toBe(weight);
    });

    expect(restored).toEqual(VANILLA_SPAWN_WEIGHTS);
  });

  it('reads the weights the onStageStart half saved through one slot', () => {
    startStage(bench);

    const ended = endStage(bench);

    expect(ended.arrived).toEqual({
      savedWeights: [...VANILLA_SPAWN_WEIGHTS],
    });
    expect(ended.recorded).toHaveLength(1);
    expect(ended.recorded[0]?.kind).toBe('setSpawnWeights');
    expect(ended.applied).toBe(1);
    expect(ended.refused).toBe(0);
  });

  it('clears the save slot once it has restored', () => {
    startStage(bench);

    const ended = endStage(bench);

    expect(ended.context.state).toEqual({});
    expect(savedWeightsOf(ended.context.state)).toBeUndefined();
    expect(bench.slot).toEqual({});
    expectWholeSlot(bench.slot);
  });

  it('leaves the weights alone when the slot saved nothing', () => {
    const ended = endStage(bench);

    expect(bench.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);
    expect(ended.recorded).toHaveLength(0);
    expect(ended.applied).toBe(0);
    expect(ended.refused).toBe(0);
    expect(bench.slot).toEqual({});
  });

  it('restores idempotently when a stage ends twice', () => {
    startStage(bench);
    endStage(bench);

    expect(bench.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);

    const second = endStage(bench);

    expect(bench.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);
    expect(second.recorded).toHaveLength(0);
    expect(bench.slot).toEqual({});
  });

  it('restores the distribution for a stage that was not cleared', () => {
    startStage(bench);
    endStage(bench, stageEndPayload(false));

    expect(bench.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);
    expect(bench.slot).toEqual({});
  });

  it('pays a bounty of a quarter of the score for a cleared stage', () => {
    const ended = endStage(bench, stageEndPayload(true, BOUNTY_SCORE));
    const paid = payloadOf(ended);

    expect(paid.score).toBe(BOUNTY_PAID_SCORE);
    expect(paid.score).toBe(
      BOUNTY_SCORE + Math.floor(BOUNTY_SCORE / CLEAR_BOUNTY_DIVISOR),
    );
    expect(paid.cleared).toBe(true);
    expect(paid.stageIndex).toBe(0);
  });

  it('pays nothing for a stage that was not cleared', () => {
    const payload = stageEndPayload(false, BOUNTY_SCORE);
    const ended = endStage(bench, payload);

    expect(ended.returned).toBeUndefined();
    expect(payload.score).toBe(BOUNTY_SCORE);
  });

  it('pays nothing when a quarter of the score floors to no point', () => {
    const ended = endStage(bench, stageEndPayload(true, UNPAYABLE_SCORE));

    expect(ended.returned).toBeUndefined();
  });

  it('leaves the board and the spawn values exactly as they arrived', () => {
    startStage(bench);

    const board = JSON.stringify(bench.grid.serialize());
    const values = bench.config.spawn.values;

    endStage(bench);

    expect(JSON.stringify(bench.grid.serialize())).toBe(board);
    expect(bench.grid.size).toBe(BOARD_SIZE);
    expect(bench.config.spawn.values).toBe(values);
    expect(bench.config.spawn.values).toEqual(VANILLA_SPAWN_VALUES);
  });

  it('changes no rule other than the spawn weights', () => {
    const merge = bench.config.merge;

    startStage(bench);
    endStage(bench);

    expect(bench.config.boardSize).toBe(BOARD_SIZE);
    expect(bench.config.winValue).toBe(WIN_VALUE);
    expect(bench.config.startTiles).toBe(START_TILES);
    expect(bench.config.merge).toBe(merge);
  });
});

/* ==========================================================================
 * 4. The save survives a reload
 * ========================================================================== */

describe('the save brittle-crown holds survives a reload', () => {
  it('saves plain JSON, so the slot round-trips through the envelope', () => {
    const started = startStage(bench);
    const saved = started.context.state;
    const encoded = JSON.stringify(saved);
    const round: unknown = JSON.parse(encoded);

    expect(round).toEqual(saved);
    expect(JSON.stringify(round)).toBe(encoded);
    expect(savedWeightsOf(round)).toEqual([...VANILLA_SPAWN_WEIGHTS]);
    expect(Object.keys(saved as Record<string, unknown>)).toEqual([
      'savedWeights',
    ]);
  });

  it('restores from a round-tripped slot on a freshly skewed config', () => {
    const opening = startStage(bench);
    const persisted: unknown = JSON.parse(
      JSON.stringify({
        id: CROWN.id,
        state: opening.context.state,
      }),
    );

    const reloaded = createBench();

    startStage(reloaded);

    expect(reloaded.config.spawn.weights).toEqual(SKEWED_SPAWN_WEIGHTS);

    reloaded.slot = isRecord(persisted) ? persisted.state : undefined;

    expect(savedWeightsOf(reloaded.slot)).toEqual([...VANILLA_SPAWN_WEIGHTS]);

    endStage(reloaded);

    expect(reloaded.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);
    expect(reloaded.slot).toEqual({});
  });

  it('skews a reloaded stage once rather than skewing the skew', () => {
    const opening = startStage(bench);
    const reloaded = createBench();

    reloaded.slot = copyJson(opening.context.state);

    startStage(reloaded);

    expect(reloaded.config.spawn.weights).toEqual(SKEWED_SPAWN_WEIGHTS);
    expect(reloaded.slot).toEqual({ savedWeights: [...VANILLA_SPAWN_WEIGHTS] });
  });

  it('keeps no module state, so two runs restore their own baselines', () => {
    const wide = createBench();

    wide.config.spawn.values = [...WIDE_SPAWN_VALUES];
    wide.config.spawn.weights = [...WIDE_SPAWN_WEIGHTS];

    startStage(wide);

    expect(wide.config.spawn.weights).toEqual(WIDE_SKEWED_WEIGHTS);

    endStage(wide);

    expect(wide.config.spawn.weights).toEqual(WIDE_SPAWN_WEIGHTS);

    startStage(bench);
    endStage(bench);

    expect(bench.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);
    expect(wide.config.spawn.weights).toEqual(WIDE_SPAWN_WEIGHTS);
  });

  it('rejects a slot whose saved weights are not usable numbers', () => {
    startStage(bench);

    bench.slot = { savedWeights: ['0.9', null] };

    const ended = endStage(bench);

    expect(ended.recorded).toHaveLength(0);
    expect(bench.config.spawn.weights).toEqual(SKEWED_SPAWN_WEIGHTS);
    expect(bench.slot).toEqual({});
  });
});

/* ==========================================================================
 * 5. The charge budget brittle-crown does not carry
 * ========================================================================== */

describe('brittle-crown carries no charge budget', () => {
  it('skews without throwing when the dispatch carries zero charges', () => {
    const started = startStage(bench, undefined, 0);

    expect(started.context.charges).toBe(0);
    expect(bench.config.spawn.weights).toEqual(SKEWED_SPAWN_WEIGHTS);
    expectDrawableDistribution(bench.config);
    expectWholeSlot(bench.slot);
    expect(bench.slot).toEqual({ savedWeights: [...VANILLA_SPAWN_WEIGHTS] });
  });

  it('restores without throwing when the dispatch carries zero charges', () => {
    startStage(bench, undefined, 0);

    const ended = endStage(bench, stageEndPayload(true), 0);

    expect(ended.context.charges).toBe(0);
    expect(bench.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);
    expectDrawableDistribution(bench.config);
    expectWholeSlot(bench.slot);
    expect(bench.slot).toEqual({});
  });

  it('asks the bus to spend no charge on either dispatch', () => {
    const started = startStage(bench, undefined, 0);
    const ended = endStage(bench, stageEndPayload(true), 0);

    expect(started.chargeRequests).toBe(0);
    expect(ended.chargeRequests).toBe(0);
  });

  it('leaves a whole slot after every dispatch of a zero-charge cycle', () => {
    startStage(bench, undefined, 0);
    expectWholeSlot(bench.slot);

    startStage(bench, undefined, 0);
    expectWholeSlot(bench.slot);

    endStage(bench, stageEndPayload(false), 0);
    expectWholeSlot(bench.slot);

    endStage(bench, stageEndPayload(true), 0);
    expectWholeSlot(bench.slot);
    expectDrawableDistribution(bench.config);
  });

  it('acts identically whatever budget the dispatch reports', () => {
    const unbudgeted = createBench();

    startStage(unbudgeted, undefined, undefined);

    const zero = createBench();

    startStage(zero, undefined, 0);

    expect(zero.config.spawn.weights).toEqual(
      unbudgeted.config.spawn.weights,
    );
    expect(zero.slot).toEqual(unbudgeted.slot);
  });
});

/* ==========================================================================
 * 6. Neither handler holds machinery of its own
 * ========================================================================== */

describe('neither brittle-crown handler holds machinery of its own', () => {
  it('reads no charge budget, the guard belonging to the bus', () => {
    for (const source of handlerSources()) {
      expect(source).not.toContain('charges');
      expect(source).not.toContain('spendCharge');
    }

    expect(handlerSources()).toHaveLength(2);
  });

  it('draws nothing through Math.random', () => {
    for (const source of handlerSources()) {
      expect(source).not.toContain('Math.random');
      expect(source).not.toContain('random');
    }
  });

  it('catches nothing and logs nothing, so a throw reaches the bus', () => {
    for (const source of handlerSources()) {
      expect(source).not.toContain('catch');
      expect(source).not.toContain('console');
    }
  });
});

/* ==========================================================================
 * 7. The randomness a stage cycle consumes
 * ========================================================================== */

describe('the randomness a brittle-crown stage cycle consumes', () => {
  it('advances no substream cursor at onStageStart', () => {
    const started = startStage(bench);

    expect(started.cursorsAfter).toEqual(started.cursorsBefore);

    for (const name of RNG_STREAM_NAMES) {
      expect(started.cursorsAfter[name]).toBe(0);
    }

    expect(RNG_STREAM_NAMES).toHaveLength(4);
  });

  it('advances no substream cursor at onStageEnd', () => {
    startStage(bench);

    const ended = endStage(bench);

    expect(ended.cursorsAfter).toEqual(ended.cursorsBefore);

    for (const name of RNG_STREAM_NAMES) {
      expect(ended.cursorsAfter[name]).toBe(0);
    }
  });

  it('leaves all four cursors at zero across a full stage cycle', () => {
    const before = bench.streams.snapshotCursors();

    startStage(bench);
    endStage(bench);

    const after = bench.streams.snapshotCursors();

    expect(after).toEqual(before);
    expect(after).toEqual({
      'spawn-value': 0,
      'spawn-position': 0,
      'relic-draw': 0,
      'rarity-weight': 0,
    });
  });

  it('addresses no substream on the context it was handed', () => {
    const started = startStage(bench);
    const ended = endStage(bench);

    expect(started.streamRequests).toBe(0);
    expect(ended.streamRequests).toBe(0);
    expect(started.context.rng.snapshotCursors()).toEqual(
      started.cursorsBefore,
    );
  });

  it('changes what a seeded spawn draw yields at the same cursor', () => {
    const values = bench.config.spawn.values;
    const plain = createRngStreams(SUITE_SEED).stream('spawn-value');
    const skewed = createRngStreams(SUITE_SEED).stream('spawn-value');

    expect(plain.cursor).toBe(skewed.cursor);
    expect(plain.pickWeighted(values, VANILLA_SPAWN_WEIGHTS)).toBe(2);
    expect(skewed.pickWeighted(values, SKEWED_SPAWN_WEIGHTS)).toBe(4);
    expect(plain.cursor).toBe(skewed.cursor);
  });

  it('raises how often the highest value is drawn over a fixed sample', () => {
    const values = bench.config.spawn.values;
    const plain = drawSample(values, VANILLA_SPAWN_WEIGHTS);
    const skewed = drawSample(values, SKEWED_SPAWN_WEIGHTS);
    const highest = 4;

    expect(plain.filter((drawn) => drawn === highest)).toHaveLength(
      VANILLA_HIGHEST_DRAWS,
    );
    expect(skewed.filter((drawn) => drawn === highest)).toHaveLength(
      SKEWED_HIGHEST_DRAWS,
    );
    expect(skewed).not.toEqual(plain);
    expect(plain).toHaveLength(DRAW_SAMPLE_SIZE);
    expect(skewed).toHaveLength(DRAW_SAMPLE_SIZE);
  });
});

/* ==========================================================================
 * 8. The suite leaves the catalogue and the defaults as it found them
 * ========================================================================== */

describe('the suite leaves the catalogue and the defaults as found', () => {
  it('has not mutated the frozen brittle-crown declaration', () => {
    expect(Object.isFrozen(CROWN)).toBe(true);
    expect(Object.isFrozen(CROWN.hooks)).toBe(true);
    expect(CROWN.id).toBe(CROWN_AT_LOAD.id);
    expect(CROWN.name).toBe(CROWN_AT_LOAD.name);
    expect(CROWN.rarity).toBe(CROWN_AT_LOAD.rarity);
    expect(CROWN.description).toBe(CROWN_AT_LOAD.description);
    expect(Object.keys(CROWN.hooks)).toEqual(CROWN_AT_LOAD.hookNames);
    expect(CROWN.hooks.onStageStart).toBe(CROWN_AT_LOAD.onStageStart);
    expect(CROWN.hooks.onStageEnd).toBe(CROWN_AT_LOAD.onStageEnd);
    expect('charges' in CROWN).toBe(CROWN_AT_LOAD.declaresCharges);
    expect(JSON.stringify(CROWN.state)).toBe(CROWN_AT_LOAD.state);
  });

  it('still builds a default config carrying the vanilla distribution', () => {
    const fresh = createDefaultRulesConfig();

    expect(fresh.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);
    expect(fresh.spawn.values).toEqual(VANILLA_SPAWN_VALUES);
    expect(fresh.boardSize).toBe(BOARD_SIZE);
    expect(fresh.winValue).toBe(WIN_VALUE);
    expect(fresh.startTiles).toBe(START_TILES);
    expect(Object.isFrozen(fresh.spawn.weights)).toBe(false);
  });

  it('gives each test a bench sharing no object with any other', () => {
    const other = createBench();

    expect(other.config).not.toBe(bench.config);
    expect(other.config.spawn.weights).not.toBe(bench.config.spawn.weights);
    expect(other.grid).not.toBe(bench.grid);
    expect(other.slot).not.toBe(bench.slot);
    expect(other.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);
    expect(bench.config.spawn.weights).toEqual(VANILLA_SPAWN_WEIGHTS);
  });
});
