// Isolation suite of `chain-catalyst`, the rarity-index-3 relic of the
// `merge-magic` family declared in src/relics/families/merge-magic.ts.
//
// The three properties every suite under tests/unit/relics/ holds a relic to,
// asserted here against this one relic and nothing else:
//   1. it fires only on the hooks it binds;
//   2. it produces its specified effect — the widened merge predicate it
//      records on `onStageStart`, and the corrected produced value it returns
//      on `onMerge`;
//   3. it respects `charges`, including an invocation made while the notional
//      subscription budget stands at zero.
//
// THE HANDLERS ARE INVOKED DIRECTLY, through a `HookContext` this file builds.
// The dispatch mechanism — pickup order, the charge guard, the compounding of
// one handler's return into the next, error isolation — belongs to
// src/engine/hook-bus.ts and is asserted in tests/unit/engine/hook-bus.test.ts
// and tests/unit/engine/hook-bus-charges.test.ts. Nothing below re-proves it.
//
// Vanilla provenance, the merge branch of js/game_manager.js, deleted:
//   L156  `next && next.value === tile.value && !next.mergedFrom`
//         -> `config.merge.canMerge`, the member this relic records a wrapper
//            over, with the `next &&` existence guard left outside it.
//   L157  `new Tile(positions.next, tile.value * 2)`
//         -> `config.merge.produce`, whose return src/engine/move-resolver.ts
//            carries into the payload as `resultValue`.
//   L167  `self.score += merged.value`
//         -> the payload's `scoreDelta`, dispatched EQUAL to `resultValue`.
//   L170  `merged.value === 2048`
//         -> `config.winValue`, compared in src/engine/terminal-state.ts.
// Every expectation below is DERIVED from `config.merge.produce`,
// `defaultCanMerge` and `defaultProduceMergeValue`. No doubling table and no
// `* 2` literal stands in for any of the three.
//
// Traceability rows of docs/TRACEABILITY_MATRIX.md this suite is evidence for:
//   TR-MERGE-04    the `chain-catalyst` declaration and its two handlers
//   TR-HOOK-01     onStageStart, js/game_manager.js L35-L59
//   TR-HOOK-03     onMerge, js/game_manager.js L156-L170
//   TR-CONFIG-05   the merge predicate and producer pair
//   TR-DEFAULT-05  `defaultCanMerge`, js/game_manager.js L156
//   TR-DEFAULT-06  `defaultProduceMergeValue`, js/game_manager.js L157
//
// Named figures these assertions are the mechanical proof of: Figure 4, "Turn
// Data Flow: From Keystroke to Composited Frame and Persisted Run State", in
// docs/architecture/data-flow.md, whose `Merge condition from
// config.merge.canMerge` decision node and `onMerge dispatch, score delta
// applied` node are the two steps this relic rewrites; and Figure 5, "Hook
// Dispatch Sequence: Pickup-Order Fan-Out with Charge Guard and Error
// Isolation", in docs/architecture/hook-dispatch-sequence.md, whose
// transformed-payload return is what section 4 reads back.
//
// Coverage owned by sibling suites and not repeated here: the installed
// predicate reached through a real bus and the two-relic wrapper chain
// (tests/unit/relics/relic-effects.test.ts and
// tests/unit/relics/merge-magic.test.ts), the win comparison against
// `config.winValue` (tests/unit/engine/terminal-state.test.ts), the merge
// schema (tests/unit/config/rules-config.test.ts), and the board-effect queue
// itself (tests/unit/engine/board-effects.test.ts).
//
// Decisions of docs/DECISION_LOG.md this suite is the evidence for:
// DL-MERGE-01, DL-MERGE-02 and DL-CONFIG-01.
//
// This suite reads no DOM and no storage, installs no mock, replaces no
// global, reads no clock and starts no timer; every double below is
// hand-written, and any draw would resolve against a substream derived from
// one literal seed. It runs in the `unit:dom-free` project of
// vitest.config.ts, whose environment is 'node'.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultRulesConfig,
  defaultCanMerge,
  defaultProduceMergeValue,
} from '../../../src/config/default-config';
import type {
  MergePredicate,
  MergeProducer,
  MergeTileView,
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
  MergePayload,
  ReadonlyGridView,
  ReadonlyRulesView,
  StageStartPayload,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import type {
  CorrelationId,
  Position,
  SerializedGrid,
} from '../../../src/engine/types';
import { MERGE_MAGIC_FAMILY } from '../../../src/relics/families/merge-magic';
import { findRelicById } from '../../../src/relics/relic-registry';
import type { Relic } from '../../../src/relics/relic-types';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
} from '../../../src/rng/rng-streams';
import type {
  RngCursorMap,
  RngStreams,
} from '../../../src/rng/rng-streams';
import { MERGE_PAIR_BOARD } from '../../fixtures/boards';

/* ==========================================================================
 * 1. The harness
 * ========================================================================== */

/** Identifier of the relic under test. */
const RELIC_ID = 'chain-catalyst';

/** The one seed every substream in this suite is derived from. */
const SUITE_SEED = 'chain-catalyst-isolation';

/**
 * Run correlation identifier the constructed context carries, so the
 * correlation member of `HookContext` is populated on every dispatch this
 * suite makes.
 */
const SUITE_CORRELATION: CorrelationId = 'run-chain-catalyst-isolation';

/** Subscriber identity the constructed context carries. */
const SUITE_SUBSCRIBER = 'chain-catalyst';

/** Pickup position the constructed context carries. */
const SUITE_PICKUP_ORDER = 0;

/** Goal target the constructed `onStageStart` payload carries. */
const SUITE_GOAL_TARGET = 128;

/** How many rungs `reachableFrom` walks before reporting no match. */
const LADDER_WALK_LIMIT = 32;

/** Face value the single-pair probes below are built up from. */
const PROBE_VALUE = 4;

/** Lower operands the widening probes walk up from. */
const LADDER_PROBE_LOWS: readonly number[] = [2, 4, 512];

/** How many rungs beyond the neighbour the bounding probes reach. */
const BEYOND_NEIGHBOUR_RUNGS = 3;

/** Score an earlier handler on the hook is taken to have accumulated. */
const ACCUMULATED_SCORE = 500;

/** Charge budget of a subscription whose budget is spent. */
const SPENT_BUDGET = 0;

/** The four hook names `chain-catalyst` binds nothing to. */
const UNBOUND_HOOKS: readonly HookName[] = HOOK_NAMES.filter(
  (name) => name !== 'onStageStart' && name !== 'onMerge',
);

/** The members `MergePayload` declares, in the order this suite builds them. */
const MERGE_PAYLOAD_MEMBERS: readonly string[] = [
  'resultValue',
  'scoreDelta',
  'source',
  'target',
];

/**
 * Every named substream at rest: the cursor map a dispatch taking no draw
 * reads both before and after it runs. `RngCursorMap` is keyed by every
 * `StreamName`, so an added substream fails to compile here, and section 6
 * asserts these keys against the exported `RNG_STREAM_NAMES` tuple.
 */
const CURSORS_AT_REST: RngCursorMap = Object.freeze({
  'spawn-value': 0,
  'spawn-position': 0,
  'relic-draw': 0,
  'rarity-weight': 0,
});

/**
 * The relic under test, read out of the family that declares it.
 *
 * @returns The declaration.
 * @throws {Error} If the family declares no relic under `RELIC_ID`, so a
 *   rename fails loudly rather than silently emptying this suite.
 */
function relicUnderTest(): Relic {
  const declared = MERGE_MAGIC_FAMILY.relics.find(
    (relic) => relic.id === RELIC_ID,
  );

  if (declared === undefined) {
    throw new Error(
      `The merge-magic family declares no relic with the id ${RELIC_ID}.`,
    );
  }

  return declared;
}

/**
 * The handler the relic binds to `onStageStart`.
 *
 * @returns The handler.
 * @throws {Error} If the binding is absent.
 */
function stageStartHandler(): HookHandler<'onStageStart'> {
  const handler = relicUnderTest().hooks.onStageStart;

  if (handler === undefined) {
    throw new Error(`The relic ${RELIC_ID} binds no onStageStart handler.`);
  }

  return handler;
}

/**
 * The handler the relic binds to `onMerge`.
 *
 * @returns The handler.
 * @throws {Error} If the binding is absent.
 */
function mergeHandler(): HookHandler<'onMerge'> {
  const handler = relicUnderTest().hooks.onMerge;

  if (handler === undefined) {
    throw new Error(`The relic ${RELIC_ID} binds no onMerge handler.`);
  }

  return handler;
}

/** The declaration as it stood when this module was imported. */
const DECLARED_AT_IMPORT = Object.freeze({
  id: relicUnderTest().id,
  name: relicUnderTest().name,
  rarity: relicUnderTest().rarity,
  description: relicUnderTest().description,
  hookNames: Object.freeze(Object.keys(relicUnderTest().hooks)),
  onStageStart: stageStartHandler(),
  onMerge: mergeHandler(),
});

/* --------------------------------------------------------------------------
 * 1.1 Operands and payloads
 * ----------------------------------------------------------------------- */

/**
 * A live tile, which is the operand src/engine/move-resolver.ts L300 hands
 * `config.merge.canMerge` and L303 projects into the merge payload. `Tile`
 * satisfies both `MergeTileView` and `ReadonlyTileView` structurally.
 *
 * @param x Column the tile occupies.
 * @param y Row the tile occupies.
 * @param value Face value the tile carries.
 * @returns The tile.
 */
function tileAt(x: number, y: number, value: number): Tile {
  return new Tile({ x, y }, value);
}

/**
 * A live tile carrying a recorded merge pair, which is the state
 * js/game_manager.js L158 left on a tile it had just produced. `mergedFrom` is
 * read for presence, and the pair is recorded as two tiles of `parent` so the
 * shape stays faithful to L158.
 *
 * @param x Column the tile occupies.
 * @param y Row the tile occupies.
 * @param value Face value the tile carries.
 * @param parent Face value of each tile the pair records.
 * @returns The tile, with `mergedFrom` populated.
 */
function mergedTileAt(
  x: number,
  y: number,
  value: number,
  parent: number,
): Tile {
  const tile = tileAt(x, y, value);

  tile.mergedFrom = [tileAt(x, y, parent), tileAt(x, y, parent)];

  return tile;
}

/**
 * A face value projected onto the operand shape the merge rules read, which is
 * the projection src/engine/terminal-state.ts supplies to a neighbour probe:
 * the value alone, with no merge recorded against it.
 *
 * @param value Face value to project.
 * @returns The operand.
 */
function operand(value: number): MergeTileView {
  return { value, mergedFrom: null };
}

/**
 * A non-doubling producer, for the substitution that shows ladder adjacency is
 * measured with the producer in force.
 *
 * @param moving Operand the value is taken from.
 * @returns Three times the moving operand's value.
 */
const tripleMergeValue: MergeProducer = (moving) => moving.value * 3;

/**
 * Applies a producer to one face value, as a merge of a pair carrying that
 * value would.
 *
 * @param produce Producer to apply.
 * @param value Face value to raise.
 * @returns The value the producer yields.
 */
function raise(produce: MergeProducer, value: number): number {
  const view = operand(value);

  return produce(view, view);
}

/**
 * Reports whether `value` is a rung the producer reaches from `start`, so a
 * corrected result can be shown to be a value the base game could itself have
 * produced. Bounded by `LADDER_WALK_LIMIT` applications.
 *
 * @param produce Producer the rungs are walked with.
 * @param start Face value the walk begins at.
 * @param value Face value to look for.
 * @returns `true` when the walk reaches `value`.
 */
function reachableFrom(
  produce: MergeProducer,
  start: number,
  value: number,
): boolean {
  let rung = start;

  for (let step = 0; step < LADDER_WALK_LIMIT; step += 1) {
    rung = raise(produce, rung);

    if (rung === value) {
      return true;
    }
  }

  return false;
}

/* --------------------------------------------------------------------------
 * 1.2 The capability views a dispatch carries
 * ----------------------------------------------------------------------- */

/**
 * The frozen rules projection src/engine/hook-bus.ts builds from the live
 * `RulesConfig` once per dispatch. Built per dispatch here as well, so a rule
 * substituted between dispatches is the rule the next one reads, and the
 * spawn arrays are copied so freezing the projection leaves the live config
 * writable.
 *
 * @param config Live rules to project.
 * @returns The readonly view.
 */
function rulesView(config: RulesConfig): ReadonlyRulesView {
  const view: ReadonlyRulesView = {
    boardSize: config.boardSize,
    winValue: config.winValue,
    startTiles: config.startTiles,
    spawn: Object.freeze({
      values: Object.freeze(config.spawn.values.slice()),
      weights: Object.freeze(config.spawn.weights.slice()),
    }),
    merge: Object.freeze({
      canMerge: config.merge.canMerge,
      produce: config.merge.produce,
    }),
  };

  return Object.freeze(view);
}

/**
 * The query half of the live board, with `cellValue` standing in for
 * `cellContent` so no live `Tile` is reachable through it. Reads resolve
 * against the board in force at the moment they are called.
 *
 * @param grid Live board to face.
 * @returns The readonly view.
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

/* --------------------------------------------------------------------------
 * 1.3 The board-effect queue a dispatch records through
 * ----------------------------------------------------------------------- */

/**
 * A fresh coordinate, so a recorded command holds no object its caller can
 * write through.
 *
 * @param cell Coordinate to copy.
 * @returns The copy.
 */
function cellOf(cell: Position): Position {
  return { x: cell.x, y: cell.y };
}

/**
 * Reduces a descriptor to the command it names, reading both spellings of a
 * restore's lattice and both of a resize's edge length, as
 * src/engine/board-effects.ts does.
 *
 * Validation beyond a callable predicate and a present operand is that
 * module's own and is asserted in tests/unit/engine/board-effects.test.ts;
 * this reduction records what it is handed.
 *
 * @param effect Descriptor to reduce.
 * @returns The command, or `null` for a descriptor naming none.
 */
function commandOf(effect: BoardEffectRequest): BoardEffect | null {
  switch (effect.kind) {
    case 'insertTile':
      return {
        kind: 'insertTile',
        cell: cellOf(effect.cell),
        value: effect.value,
      };

    case 'removeTile':
      return { kind: 'removeTile', cell: cellOf(effect.cell) };

    case 'moveTile':
      return {
        kind: 'moveTile',
        from: cellOf(effect.from),
        to: cellOf(effect.to),
        tween: effect.tween ?? true,
      };

    case 'restoreBoard': {
      const snapshot: SerializedGrid | undefined =
        effect.snapshot ?? effect.board;

      if (snapshot === undefined) {
        return null;
      }

      return { kind: 'restoreBoard', snapshot, score: effect.score };
    }

    case 'resizeBoard': {
      const size: number | undefined = effect.size ?? effect.boardSize;

      return size === undefined ? null : { kind: 'resizeBoard', size };
    }

    case 'setMergePredicate':
      return typeof effect.predicate === 'function'
        ? { kind: 'setMergePredicate', predicate: effect.predicate }
        : null;

    case 'setSpawnWeights':
      return { kind: 'setSpawnWeights', weights: effect.weights.slice() };

    default:
      return null;
  }
}

/**
 * A queue that RECORDS every command in the vocabulary and answers its five
 * queries from the live lattice. Each named member reduces its arguments
 * through `commandOf`, the same reduction `request` uses, so the named and the
 * descriptor forms cannot diverge. Nothing throws, and a command the reduction
 * refuses raises `refused` and is not recorded.
 *
 * @param grid Live board the queries read.
 * @returns The queue.
 */
function createEffectQueue(grid: Grid): BoardEffectQueue {
  const recorded: BoardEffect[] = [];
  let refusals = 0;

  const record = (command: BoardEffect | null): boolean => {
    if (command === null) {
      refusals += 1;

      return false;
    }

    recorded.push(command);

    return true;
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

    insertTile: (cell, value) =>
      record(commandOf({ kind: 'insertTile', cell, value })),
    removeTile: (cell) => record(commandOf({ kind: 'removeTile', cell })),
    moveTile: (from, to, tween) =>
      record(commandOf({ kind: 'moveTile', from, to, tween })),
    restoreBoard: (snapshot, score) =>
      record(commandOf({ kind: 'restoreBoard', snapshot, score })),
    resizeBoard: (size) => record(commandOf({ kind: 'resizeBoard', size })),
    setMergePredicate: (predicate) =>
      record(commandOf({ kind: 'setMergePredicate', predicate })),
    setSpawnWeights: (weights) =>
      record(commandOf({ kind: 'setSpawnWeights', weights })),
    request: (effect) => record(commandOf(effect)),
    requested: () => Object.freeze(recorded.slice()),
    cellValue: (cell) => grid.cellContent(cell)?.value ?? null,
    cellOccupied: (cell) => grid.cellOccupied(cell),
    availableCells: () => grid.availableCells(),

    occupiedCells: () => {
      const found: { x: number; y: number; value: number }[] = [];

      grid.eachCell((x, y, tile) => {
        if (tile) {
          found.push({ x, y, value: tile.value });
        }
      });

      return found;
    },

    clear: (): void => {
      recorded.length = 0;
    },
  };

  return queue;
}

/* --------------------------------------------------------------------------
 * 1.4 The bench and the dispatch
 * ----------------------------------------------------------------------- */

/** The collaborators one test drives the two handlers through. */
interface Bench {
  /**
   * The live rules. Always from `createDefaultRulesConfig()`, never the
   * deep-frozen `DEFAULT_RULES_CONFIG`, and rebuilt for every test.
   */
  readonly config: RulesConfig;
  readonly grid: Grid;
  readonly streams: RngStreams;
  readonly effects: BoardEffectQueue;

  /** Charges the handlers asked the bus to spend. */
  chargeRequests: number;

  /** The subscriber's own state slot, as the bus would carry it. */
  state: unknown;
}

/**
 * Builds a bench over a fresh, writable rules object and one seeded substream
 * table.
 *
 * @param grid Board to drive against. Defaults to an empty board at the
 *   configured edge length.
 * @returns The bench.
 */
function createBench(grid?: Grid): Bench {
  const config = createDefaultRulesConfig();
  const board = grid ?? new Grid(config.boardSize);

  return {
    config,
    grid: board,
    streams: createRngStreams(SUITE_SEED),
    effects: createEffectQueue(board),
    chargeRequests: 0,
    state: undefined,
  };
}

/**
 * The context one dispatch carries: the three capability views, the effect
 * queue, the run correlation identifier, the dispatch identity and the
 * subscriber's own state slot.
 *
 * The views are rebuilt on every call, as src/engine/hook-bus.ts rebuilds them
 * per dispatch, and `state` is an accessor pair onto the bench so a handler's
 * write is observable.
 *
 * @param bench Bench to build over.
 * @param hook Hook being dispatched.
 * @param charges Charges the notional subscription holds.
 * @returns The context.
 */
function contextFor(
  bench: Bench,
  hook: HookName,
  charges?: number,
): HookContext {
  return {
    config: rulesView(bench.config),
    rng: bench.streams,
    grid: gridView(bench.grid),
    effects: bench.effects,
    correlationId: SUITE_CORRELATION,
    hook,
    subscriberId: SUITE_SUBSCRIBER,
    pickupOrder: SUITE_PICKUP_ORDER,
    charges,

    spendCharge: (amount) => {
      bench.chargeRequests += amount ?? 1;

      return false;
    },

    get state(): unknown {
      return bench.state;
    },

    set state(value: unknown) {
      bench.state = value;
    },
  };
}

/**
 * A stage-start payload carrying the bench's own edge length.
 *
 * @param bench Bench the edge length is read from.
 * @param stageIndex Stage being prepared.
 * @returns The payload.
 */
function stageStartPayloadFor(
  bench: Bench,
  stageIndex = 0,
): StageStartPayload {
  return {
    stageIndex,
    goal: { kind: 'highest-tile', target: SUITE_GOAL_TARGET },
    seed: SUITE_SEED,
    boardSize: bench.config.boardSize,
  };
}

/**
 * A merge payload shaped as src/engine/move-resolver.ts L301-L308 dispatches
 * one: the two live tiles, `resultValue` the producer in force applied to the
 * MOVING tile as js/game_manager.js L157 did, and `scoreDelta` equal to it as
 * L167 accrued it.
 *
 * @param bench Bench the producer is read from.
 * @param source Tile being absorbed.
 * @param target Tile it merges into.
 * @returns The payload.
 */
function resolvedMerge(
  bench: Bench,
  source: Tile,
  target: Tile,
): MergePayload {
  const produced = bench.config.merge.produce(source, target);

  return { source, target, resultValue: produced, scoreDelta: produced };
}

/**
 * A merge payload carrying an already accumulated result and score, which is
 * what the bus hands a handler dispatched after another one.
 *
 * @param source Tile being absorbed.
 * @param target Tile it merges into.
 * @param resultValue Value accumulated so far.
 * @param scoreDelta Score accumulated so far.
 * @returns The payload.
 */
function accumulatedMerge(
  source: Tile,
  target: Tile,
  resultValue: number,
  scoreDelta: number,
): MergePayload {
  return { source, target, resultValue, scoreDelta };
}

/**
 * Invokes the `onStageStart` handler.
 *
 * @param bench Bench to dispatch against.
 * @param stageIndex Stage being prepared.
 * @param charges Charges the notional subscription holds.
 * @returns Whatever the handler returned.
 */
function dispatchStageStart(
  bench: Bench,
  stageIndex = 0,
  charges?: number,
): StageStartPayload | void {
  return stageStartHandler()(
    stageStartPayloadFor(bench, stageIndex),
    contextFor(bench, 'onStageStart', charges),
  );
}

/**
 * Invokes the `onMerge` handler.
 *
 * @param bench Bench to dispatch against.
 * @param payload Merge being resolved.
 * @param charges Charges the notional subscription holds.
 * @returns Whatever the handler returned.
 */
function dispatchMerge(
  bench: Bench,
  payload: MergePayload,
  charges?: number,
): MergePayload | void {
  return mergeHandler()(payload, contextFor(bench, 'onMerge', charges));
}

/**
 * The payload a merge dispatch resolved to, holding the dispatch to having
 * returned one.
 *
 * @param returned Whatever the handler returned.
 * @returns The payload.
 * @throws {Error} If the handler returned nothing.
 */
function returnedMerge(returned: MergePayload | void): MergePayload {
  if (returned === undefined) {
    throw new Error('The onMerge handler returned no payload.');
  }

  return returned;
}

/**
 * The merge predicate a dispatch recorded, holding the dispatch to exactly one
 * recorded command and to that command being the substitution.
 *
 * @param bench Bench the queue is read from.
 * @returns The recorded predicate.
 * @throws {Error} If no substitution was recorded.
 */
function recordedPredicate(bench: Bench): MergePredicate {
  const commands = bench.effects.requested();

  expect(commands.map((command) => command.kind)).toEqual([
    'setMergePredicate',
  ]);

  const command = commands[0];

  if (command.kind !== 'setMergePredicate') {
    throw new Error('The dispatch recorded no merge-predicate substitution.');
  }

  return command.predicate;
}

/**
 * Applies the recorded substitution to the live rules, which is what
 * src/engine/board-effects.ts does once a handler's return has been accepted,
 * and empties the queue as the bus opens a fresh one per handler.
 *
 * @param bench Bench to commit against.
 * @returns The predicate now in force.
 */
function commitRecordedPredicate(bench: Bench): MergePredicate {
  const installed = recordedPredicate(bench);

  bench.config.merge.canMerge = installed;
  bench.effects.clear();

  return installed;
}

/**
 * Opens a stage and hands back the predicate that stage left in force.
 *
 * @param bench Bench to dispatch against.
 * @param stageIndex Stage being prepared.
 * @returns The predicate now in force.
 */
function openStage(bench: Bench, stageIndex = 0): MergePredicate {
  dispatchStageStart(bench, stageIndex);

  return commitRecordedPredicate(bench);
}

/**
 * The rung whose image under `produce` first reaches `ceiling`, walked up from
 * `start` and bounded by `LADDER_WALK_LIMIT` applications.
 *
 * @param produce Producer the rungs are walked with.
 * @param start Face value the walk begins at.
 * @param ceiling Value the walk stops beneath.
 * @returns The rung.
 */
function rungBeneath(
  produce: MergeProducer,
  start: number,
  ceiling: number,
): number {
  let rung = start;

  for (let step = 0; step < LADDER_WALK_LIMIT; step += 1) {
    if (raise(produce, rung) >= ceiling) {
      return rung;
    }

    rung = raise(produce, rung);
  }

  return rung;
}

/** The bench every test in this suite is handed. */
let bench: Bench;

beforeEach(() => {
  bench = createBench();
});

/* ==========================================================================
 * 2. Property 1: it fires only on the hooks it binds
 * ========================================================================== */

describe('the chain-catalyst declaration, TR-MERGE-04', () => {
  it('is reached by id from its family and from the catalogue', () => {
    const declared = relicUnderTest();

    expect(MERGE_MAGIC_FAMILY.name).toBe('merge-magic');
    expect(declared.id).toBe(RELIC_ID);
    expect(findRelicById(RELIC_ID)).toBe(declared);
  });

  it('binds onStageStart then onMerge, and no other hook', () => {
    expect(Object.keys(relicUnderTest().hooks)).toEqual([
      'onStageStart',
      'onMerge',
    ]);
  });

  it('binds only names the six-hook surface declares', () => {
    for (const name of Object.keys(relicUnderTest().hooks)) {
      expect(HOOK_NAMES).toContain(name);
    }
  });

  it('leaves every hook it does not bind absent, not undefined', () => {
    const bound = relicUnderTest().hooks;

    expect(UNBOUND_HOOKS).toEqual([
      'onBeforeMove',
      'onSpawn',
      'onAfterMove',
      'onStageEnd',
    ]);

    for (const name of UNBOUND_HOOKS) {
      expect(name in bound).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(bound, name)).toBe(false);
    }
  });

  it('binds a function under each of the two names', () => {
    expect(typeof stageStartHandler()).toBe('function');
    expect(typeof mergeHandler()).toBe('function');
  });

  it('declares the five members it carries and no eighth field', () => {
    expect(Object.keys(relicUnderTest()).sort()).toEqual([
      'description',
      'hooks',
      'id',
      'name',
      'rarity',
    ]);
  });
});

/* ==========================================================================
 * 3. Property 2a: the merge predicate the stage-start hook records
 * ========================================================================== */

describe('the merge predicate chain-catalyst records on stage start', () => {
  it('records exactly one board command, the rule substitution', () => {
    dispatchStageStart(bench);

    expect(bench.effects.length).toBe(1);
    expect(bench.effects.refused).toBe(0);
    expect(bench.effects.requested().map((command) => command.kind)).toEqual([
      'setMergePredicate',
    ]);
    expect(typeof recordedPredicate(bench)).toBe('function');
  });

  it('returns nothing, so the stage goal resolves as it arrived', () => {
    const payload = stageStartPayloadFor(bench);
    const returned = stageStartHandler()(
      payload,
      contextFor(bench, 'onStageStart'),
    );

    expect(returned).toBeUndefined();
    expect(payload.goal).toEqual({
      kind: 'highest-tile',
      target: SUITE_GOAL_TARGET,
    });
    expect(payload.boardSize).toBe(bench.config.boardSize);
  });

  it('writes no rule itself, leaving the live predicate in place', () => {
    const before = bench.config.merge.canMerge;

    expect(before).toBe(defaultCanMerge);

    dispatchStageStart(bench);

    // src/engine/board-effects.ts applies the recorded command once the
    // handler's return has been accepted; the handler writes nothing.
    expect(bench.config.merge.canMerge).toBe(before);
    expect(recordedPredicate(bench)).not.toBe(before);
  });

  it('permits a pair adjacent on the ladder the producer defines', () => {
    const installed = openStage(bench);
    const produce = bench.config.merge.produce;

    for (const low of LADDER_PROBE_LOWS) {
      const high = raise(produce, low);
      const moving = tileAt(1, 0, low);
      const stationary = tileAt(0, 0, high);

      // js/game_manager.js L156 required the two values to be EQUAL, so the
      // base rule refuses the pair in both operand orders.
      expect(defaultCanMerge(moving, stationary)).toBe(false);
      expect(defaultCanMerge(stationary, moving)).toBe(false);

      expect(installed(moving, stationary)).toBe(true);
      expect(installed(stationary, moving)).toBe(true);
    }
  });

  it('refuses a pair that is not adjacent, so the widening is bounded', () => {
    const installed = openStage(bench);
    const produce = bench.config.merge.produce;

    for (const low of LADDER_PROBE_LOWS) {
      let high = raise(produce, low);

      for (let step = 0; step < BEYOND_NEIGHBOUR_RUNGS; step += 1) {
        high = raise(produce, high);

        const moving = tileAt(1, 0, low);
        const stationary = tileAt(0, 0, high);

        expect(defaultCanMerge(moving, stationary)).toBe(false);
        expect(installed(moving, stationary)).toBe(false);
        expect(installed(stationary, moving)).toBe(false);
      }
    }
  });

  it('keeps every equal-valued pair merging, as the base rule does', () => {
    const installed = openStage(bench);

    for (const value of LADDER_PROBE_LOWS) {
      const moving = tileAt(1, 0, value);
      const stationary = tileAt(0, 0, value);

      expect(installed(moving, stationary)).toBe(
        defaultCanMerge(moving, stationary),
      );
      expect(installed(moving, stationary)).toBe(true);
    }
  });

  it('refuses an equal pair whose target already merged this turn', () => {
    const installed = openStage(bench);
    const moving = tileAt(1, 0, PROBE_VALUE);
    const merged = mergedTileAt(0, 0, PROBE_VALUE, PROBE_VALUE);

    // js/game_manager.js L156 held `!next.mergedFrom` beside the equality
    // test, which is the one-merger-per-traversal guard.
    expect(defaultCanMerge(moving, merged)).toBe(false);
    expect(installed(moving, merged)).toBe(false);
  });

  it(
    'admits a ladder pair on the two values alone, so a target that ' +
      'already merged this turn is admitted by the widening and not by the ' +
      'base rule',
    () => {
      const installed = openStage(bench);
      const high = raise(bench.config.merge.produce, PROBE_VALUE);
      const moving = tileAt(1, 0, PROBE_VALUE);
      const merged = mergedTileAt(0, 0, high, PROBE_VALUE);

      // The wrapper preserves the delegate's verdict as an OR: the delegate
      // refuses for the recorded merge, and the ladder branch then decides on
      // the two face values.
      expect(defaultCanMerge(moving, merged)).toBe(false);
      expect(installed(moving, merged)).toBe(true);
    },
  );

  it('leaves the base rule and the shared default rules untouched', () => {
    const installed = openStage(bench);
    const moving = tileAt(1, 0, PROBE_VALUE);

    expect(installed).not.toBe(defaultCanMerge);
    expect(createDefaultRulesConfig().merge.canMerge).toBe(defaultCanMerge);
    expect(
      defaultCanMerge(moving, mergedTileAt(0, 0, PROBE_VALUE, PROBE_VALUE)),
    ).toBe(false);
    expect(defaultCanMerge(moving, tileAt(0, 0, PROBE_VALUE))).toBe(true);
    expect(
      defaultCanMerge(
        moving,
        tileAt(0, 0, raise(defaultProduceMergeValue, PROBE_VALUE)),
      ),
    ).toBe(false);
  });

  it('throws on neither operand shape its two callers supply', () => {
    const installed = openStage(bench);
    const high = raise(bench.config.merge.produce, PROBE_VALUE);
    const moving = tileAt(1, 0, PROBE_VALUE);

    // src/engine/move-resolver.ts supplies live tiles; the neighbour probe of
    // src/engine/terminal-state.ts supplies value-only projections. The
    // `next &&` existence guard stays outside the predicate in both.
    expect(() => installed(moving, tileAt(0, 0, high))).not.toThrow();
    expect(() => installed(operand(PROBE_VALUE), operand(high))).not.toThrow();
    expect(() =>
      installed(moving, mergedTileAt(0, 0, high, PROBE_VALUE)),
    ).not.toThrow();
    expect(typeof installed(operand(PROBE_VALUE), operand(high))).toBe(
      'boolean',
    );
  });

  it('measures adjacency with the producer in force, not a table', () => {
    bench.config.merge.produce = tripleMergeValue;

    const installed = openStage(bench);
    const oneRungUp = raise(tripleMergeValue, PROBE_VALUE);
    const twoRungsUp = raise(tripleMergeValue, oneRungUp);
    const doubled = raise(defaultProduceMergeValue, PROBE_VALUE);
    const moving = tileAt(1, 0, PROBE_VALUE);

    expect(installed(moving, tileAt(0, 0, oneRungUp))).toBe(true);
    expect(installed(moving, tileAt(0, 0, twoRungsUp))).toBe(false);
    expect(installed(moving, tileAt(0, 0, doubled))).toBe(false);
    expect(installed(moving, tileAt(0, 0, PROBE_VALUE))).toBe(true);
  });

  it('replaces its own wrapper on a later stage instead of nesting', () => {
    const first = openStage(bench);

    bench.config.merge.produce = tripleMergeValue;

    const second = openStage(bench, 1);
    const tripled = raise(tripleMergeValue, PROBE_VALUE);
    const doubled = raise(defaultProduceMergeValue, PROBE_VALUE);
    const moving = tileAt(1, 0, PROBE_VALUE);

    // A wrapper nested over the first would still admit the doubling
    // neighbour through its delegate; the replacement admits only the rung
    // the producer now in force names.
    expect(second).not.toBe(first);
    expect(second(moving, tileAt(0, 0, tripled))).toBe(true);
    expect(second(moving, tileAt(0, 0, doubled))).toBe(false);
    expect(second(moving, tileAt(0, 0, PROBE_VALUE))).toBe(true);
  });
});

/* ==========================================================================
 * 4. Property 2b: the produced value the merge hook corrects
 * ========================================================================== */

describe('the produced value chain-catalyst corrects on a merge', () => {
  it('returns nothing for an equal pair, leaving the merge alone', () => {
    const source = tileAt(1, 0, PROBE_VALUE);
    const target = tileAt(0, 0, PROBE_VALUE);
    const payload = resolvedMerge(bench, source, target);
    const returned = dispatchMerge(bench, payload);

    expect(returned).toBeUndefined();
    expect(payload.resultValue).toBe(defaultProduceMergeValue(source, target));
    expect(payload.scoreDelta).toBe(payload.resultValue);
  });

  it('reads the equality alone, not the value the merge carries', () => {
    const source = tileAt(1, 0, PROBE_VALUE);
    const target = tileAt(0, 0, PROBE_VALUE);
    const lowered = accumulatedMerge(
      source,
      target,
      PROBE_VALUE,
      PROBE_VALUE,
    );

    // An accumulated result standing BELOW the producer's own return is the
    // one an arithmetic-only guard would raise; the equal pair is left alone.
    expect(raise(bench.config.merge.produce, PROBE_VALUE)).toBeGreaterThan(
      lowered.resultValue,
    );
    expect(dispatchMerge(bench, lowered)).toBeUndefined();
    expect(lowered.resultValue).toBe(PROBE_VALUE);
    expect(lowered.scoreDelta).toBe(PROBE_VALUE);
  });

  it('corrects a ladder pair to the producer applied to the larger', () => {
    const produce = bench.config.merge.produce;
    const source = tileAt(1, 0, PROBE_VALUE);
    const target = tileAt(0, 0, raise(produce, PROBE_VALUE));
    const payload = resolvedMerge(bench, source, target);
    const corrected = returnedMerge(dispatchMerge(bench, payload));

    // src/engine/move-resolver.ts derives the value from the MOVING tile, as
    // js/game_manager.js L157 did, so an unequal pair arrives one rung low.
    expect(payload.resultValue).toBe(raise(produce, source.value));
    expect(corrected.resultValue).toBe(raise(produce, target.value));
    expect(corrected.resultValue).not.toBe(payload.resultValue);
  });

  it('leaves a pair whose moving tile is the larger already correct', () => {
    const produce = bench.config.merge.produce;
    const target = tileAt(0, 0, PROBE_VALUE);
    const source = tileAt(1, 0, raise(produce, PROBE_VALUE));
    const payload = resolvedMerge(bench, source, target);
    const returned = dispatchMerge(bench, payload);

    expect(payload.resultValue).toBe(raise(produce, source.value));
    expect(returned).toBeUndefined();
  });

  it(
    'raises scoreDelta by the increment, so a resolver-shaped payload ' +
      'scores exactly the corrected value, as js/game_manager.js L167 ' +
      'accrued it',
    () => {
      const produce = bench.config.merge.produce;
      const source = tileAt(1, 0, PROBE_VALUE);
      const target = tileAt(0, 0, raise(produce, PROBE_VALUE));
      const payload = resolvedMerge(bench, source, target);
      const corrected = returnedMerge(dispatchMerge(bench, payload));
      const increment = corrected.resultValue - payload.resultValue;

      expect(corrected.scoreDelta).toBe(payload.scoreDelta + increment);
      expect(corrected.scoreDelta).toBe(corrected.resultValue);
    },
  );

  it('adds to what an earlier handler accumulated, never replacing it', () => {
    const produce = bench.config.merge.produce;
    const source = tileAt(1, 0, PROBE_VALUE);
    const target = tileAt(0, 0, raise(produce, PROBE_VALUE));
    const accumulated = accumulatedMerge(
      source,
      target,
      raise(produce, source.value),
      ACCUMULATED_SCORE,
    );
    const corrected = returnedMerge(dispatchMerge(bench, accumulated));
    const increment = corrected.resultValue - accumulated.resultValue;

    expect(corrected.scoreDelta).toBe(ACCUMULATED_SCORE + increment);
    expect(corrected.scoreDelta).toBeGreaterThan(corrected.resultValue);
  });

  it('corrects to a value the producer itself reaches from the pair', () => {
    const produce = bench.config.merge.produce;
    const source = tileAt(1, 0, PROBE_VALUE);
    const target = tileAt(0, 0, raise(produce, PROBE_VALUE));
    const corrected = returnedMerge(
      dispatchMerge(bench, resolvedMerge(bench, source, target)),
    );

    expect(reachableFrom(produce, source.value, corrected.resultValue)).toBe(
      true,
    );
    expect(reachableFrom(produce, target.value, corrected.resultValue)).toBe(
      true,
    );
  });

  it(
    'hands a value above the configured win value forward and adds no ' +
      'verdict of its own, src/engine/terminal-state.ts owning that ' +
      'comparison',
    () => {
      const produce = bench.config.merge.produce;
      const rung = rungBeneath(
        produce,
        bench.config.spawn.values[0],
        bench.config.winValue,
      );
      const source = tileAt(1, 0, rung);
      const target = tileAt(0, 0, raise(produce, rung));
      const corrected = returnedMerge(
        dispatchMerge(bench, resolvedMerge(bench, source, target)),
      );

      // js/game_manager.js L170 compared the produced value against the
      // literal 2048, which is now `config.winValue`.
      expect(target.value).toBe(bench.config.winValue);
      expect(corrected.resultValue).toBe(raise(produce, target.value));
      expect(corrected.resultValue).toBeGreaterThan(bench.config.winValue);
      expect(Object.keys(corrected).sort()).toEqual(MERGE_PAYLOAD_MEMBERS);
    },
  );

  it('leaves both tiles exactly as it received them', () => {
    const produce = bench.config.merge.produce;
    const source = tileAt(1, 0, PROBE_VALUE);
    const target = mergedTileAt(
      0,
      0,
      raise(produce, PROBE_VALUE),
      PROBE_VALUE,
    );
    const recordedPair = target.mergedFrom;
    const before = [source.serialize(), target.serialize()];

    dispatchMerge(bench, resolvedMerge(bench, source, target));

    expect([source.serialize(), target.serialize()]).toEqual(before);
    expect(source.previousPosition).toBeNull();
    expect(target.previousPosition).toBeNull();
    expect(source.mergedFrom).toBeNull();
    expect(target.mergedFrom).toBe(recordedPair);
  });

  it('leaves the spawn rule, win value and board size unchanged', () => {
    const produce = bench.config.merge.produce;
    const canMerge = bench.config.merge.canMerge;
    const before = {
      boardSize: bench.config.boardSize,
      winValue: bench.config.winValue,
      startTiles: bench.config.startTiles,
      values: bench.config.spawn.values.slice(),
      weights: bench.config.spawn.weights.slice(),
    };

    dispatchMerge(
      bench,
      resolvedMerge(
        bench,
        tileAt(1, 0, PROBE_VALUE),
        tileAt(0, 0, raise(produce, PROBE_VALUE)),
      ),
    );

    expect({
      boardSize: bench.config.boardSize,
      winValue: bench.config.winValue,
      startTiles: bench.config.startTiles,
      values: bench.config.spawn.values.slice(),
      weights: bench.config.spawn.weights.slice(),
    }).toEqual(before);
    expect(bench.config.merge.produce).toBe(produce);
    expect(bench.config.merge.canMerge).toBe(canMerge);
  });

  it('records no board command and installs no rule', () => {
    const produce = bench.config.merge.produce;

    dispatchMerge(
      bench,
      resolvedMerge(
        bench,
        tileAt(1, 0, PROBE_VALUE),
        tileAt(0, 0, raise(produce, PROBE_VALUE)),
      ),
    );

    expect(bench.effects.requested()).toEqual([]);
    expect(bench.effects.length).toBe(0);
    expect(bench.effects.refused).toBe(0);
  });

  it('leaves the board it was dispatched over unchanged', () => {
    const fixture = new Grid(
      MERGE_PAIR_BOARD.grid.size,
      MERGE_PAIR_BOARD.grid.cells,
    );
    const populated = createBench(fixture);
    const produce = populated.config.merge.produce;
    const before = fixture.serialize();
    const cells = MERGE_PAIR_BOARD.grid.size * MERGE_PAIR_BOARD.grid.size;

    dispatchMerge(
      populated,
      resolvedMerge(
        populated,
        tileAt(1, 0, PROBE_VALUE),
        tileAt(0, 0, raise(produce, PROBE_VALUE)),
      ),
    );

    expect(fixture.serialize()).toEqual(before);
    expect(fixture.availableCells().length).toBeLessThan(cells);
    expect(fixture.cellContent({ x: 0, y: 0 })?.value).toBe(
      MERGE_PAIR_BOARD.grid.cells[0][0]?.value,
    );
  });

  it('returns a fresh payload rather than the one it received', () => {
    const produce = bench.config.merge.produce;
    const payload = resolvedMerge(
      bench,
      tileAt(1, 0, PROBE_VALUE),
      tileAt(0, 0, raise(produce, PROBE_VALUE)),
    );
    const corrected = returnedMerge(dispatchMerge(bench, payload));

    expect(corrected).not.toBe(payload);
    expect(corrected.source).toBe(payload.source);
    expect(corrected.target).toBe(payload.target);
    expect(payload.resultValue).toBe(raise(produce, PROBE_VALUE));
    expect(Object.keys(corrected).sort()).toEqual(MERGE_PAYLOAD_MEMBERS);
  });

  it('returns nothing when the producer yields no usable value', () => {
    const source = tileAt(1, 0, PROBE_VALUE);
    const target = tileAt(
      0,
      0,
      raise(bench.config.merge.produce, PROBE_VALUE),
    );
    const payload = resolvedMerge(bench, source, target);

    bench.config.merge.produce = () => Number.NaN;

    expect(dispatchMerge(bench, payload)).toBeUndefined();
    expect(payload.resultValue).toBe(
      raise(defaultProduceMergeValue, source.value),
    );
  });
});

/* ==========================================================================
 * 5. Property 3: charges, including an invocation at a spent budget
 * ========================================================================== */

describe('chain-catalyst and the charge budget', () => {
  it('declares no charge budget, with the member absent not null', () => {
    const declared = relicUnderTest();

    expect(Object.prototype.hasOwnProperty.call(declared, 'charges')).toBe(
      false,
    );
    expect('charges' in declared).toBe(false);
    expect(declared.charges).toBeUndefined();
  });

  it('names no charge budget in either handler', () => {
    // src/engine/hook-bus.ts owns the guard and the decrement; a handler that
    // read a budget would be a second guard.
    for (const source of [
      stageStartHandler().toString(),
      mergeHandler().toString(),
    ]) {
      expect(source).not.toContain('charges');
      expect(source).not.toContain('spendCharge');
    }
  });

  it('asks the bus for no charge on either hook', () => {
    openStage(bench);
    dispatchMerge(
      bench,
      resolvedMerge(
        bench,
        tileAt(1, 0, PROBE_VALUE),
        tileAt(0, 0, raise(bench.config.merge.produce, PROBE_VALUE)),
      ),
    );

    expect(bench.chargeRequests).toBe(0);
  });

  it('corrects a merge without throwing at a spent budget', () => {
    const produce = bench.config.merge.produce;
    const payload = resolvedMerge(
      bench,
      tileAt(1, 0, PROBE_VALUE),
      tileAt(0, 0, raise(produce, PROBE_VALUE)),
    );

    expect(() => dispatchMerge(bench, payload, SPENT_BUDGET)).not.toThrow();

    const corrected = returnedMerge(
      dispatchMerge(bench, payload, SPENT_BUDGET),
    );

    expect(corrected.resultValue).toBe(raise(produce, payload.target.value));
    expect(corrected.scoreDelta).toBe(corrected.resultValue);
    expect(bench.chargeRequests).toBe(0);
  });

  it('corrupts nothing when invoked at a spent budget', () => {
    const produce = bench.config.merge.produce;
    const canMerge = bench.config.merge.canMerge;
    const board = bench.grid.serialize();

    bench.state = { held: 'unchanged' };

    dispatchMerge(
      bench,
      resolvedMerge(
        bench,
        tileAt(1, 0, PROBE_VALUE),
        tileAt(0, 0, raise(produce, PROBE_VALUE)),
      ),
      SPENT_BUDGET,
    );

    expect(typeof bench.config.merge.canMerge).toBe('function');
    expect(bench.config.merge.canMerge).toBe(canMerge);
    expect(bench.grid.serialize()).toEqual(board);
    expect(bench.state).toEqual({ held: 'unchanged' });
    expect(bench.effects.requested()).toEqual([]);
    expect(bench.chargeRequests).toBe(0);
  });

  it('records its rule without throwing at a spent budget', () => {
    expect(() => dispatchStageStart(bench, 0, SPENT_BUDGET)).not.toThrow();

    const installed = recordedPredicate(bench);

    expect(typeof installed).toBe('function');
    expect(
      installed(tileAt(1, 0, PROBE_VALUE), tileAt(0, 0, PROBE_VALUE)),
    ).toBe(true);
    expect(bench.state).toBeUndefined();
    expect(bench.chargeRequests).toBe(0);
  });
});

/* ==========================================================================
 * 6. Determinism and substream hygiene
 * ========================================================================== */

describe('chain-catalyst determinism and substream hygiene', () => {
  it('advances no named substream on either hook', () => {
    expect(bench.streams.snapshotCursors()).toEqual(CURSORS_AT_REST);

    openStage(bench);
    dispatchMerge(
      bench,
      resolvedMerge(
        bench,
        tileAt(1, 0, PROBE_VALUE),
        tileAt(0, 0, raise(bench.config.merge.produce, PROBE_VALUE)),
      ),
    );

    expect(bench.streams.snapshotCursors()).toEqual(CURSORS_AT_REST);
  });

  it('holds a cursor for every substream the run declares', () => {
    expect(Object.keys(CURSORS_AT_REST).sort()).toEqual(
      [...RNG_STREAM_NAMES].sort(),
    );
    expect(Object.keys(bench.streams.snapshotCursors()).sort()).toEqual(
      [...RNG_STREAM_NAMES].sort(),
    );
    expect(bench.streams.seed).toBe(SUITE_SEED);
  });

  it('names no randomness source in either handler', () => {
    for (const source of [
      stageStartHandler().toString(),
      mergeHandler().toString(),
    ]) {
      expect(source).not.toContain('Math.random');
      expect(source).not.toContain('random');
    }
  });

  it('suppresses no error and writes no log in either handler', () => {
    // A throw must reach src/engine/hook-bus.ts, which reports it through the
    // injected `EngineReporter` under the run correlation identifier.
    for (const source of [
      stageStartHandler().toString(),
      mergeHandler().toString(),
    ]) {
      expect(source).not.toContain('catch');
      expect(source).not.toContain('console');
    }
  });

  it('resolves two benches on one seed to the same verdicts', () => {
    const first = createBench();
    const second = createBench();
    const verdicts = (
      installed: MergePredicate,
      produce: MergeProducer,
    ): boolean[] => {
      const oneUp = raise(produce, PROBE_VALUE);

      return [
        installed(operand(PROBE_VALUE), operand(PROBE_VALUE)),
        installed(operand(PROBE_VALUE), operand(oneUp)),
        installed(operand(PROBE_VALUE), operand(raise(produce, oneUp))),
      ];
    };
    const corrected = (target: Bench): number =>
      returnedMerge(
        dispatchMerge(
          target,
          resolvedMerge(
            target,
            tileAt(1, 0, PROBE_VALUE),
            tileAt(0, 0, raise(target.config.merge.produce, PROBE_VALUE)),
          ),
        ),
      ).resultValue;
    const firstInstalled = openStage(first);
    const secondInstalled = openStage(second);

    expect(verdicts(firstInstalled, first.config.merge.produce)).toEqual(
      verdicts(secondInstalled, second.config.merge.produce),
    );
    expect(corrected(first)).toBe(corrected(second));
    expect(first.streams.snapshotCursors()).toEqual(
      second.streams.snapshotCursors(),
    );
  });
});

/* ==========================================================================
 * 7. The declaration and the shared defaults after this suite
 * ========================================================================== */

describe('the declaration and the shared defaults after this suite', () => {
  it('is unmutated, and is still frozen at both levels', () => {
    const declared = relicUnderTest();

    expect({
      id: declared.id,
      name: declared.name,
      rarity: declared.rarity,
      description: declared.description,
      hookNames: Object.keys(declared.hooks),
    }).toEqual({
      id: DECLARED_AT_IMPORT.id,
      name: DECLARED_AT_IMPORT.name,
      rarity: DECLARED_AT_IMPORT.rarity,
      description: DECLARED_AT_IMPORT.description,
      hookNames: [...DECLARED_AT_IMPORT.hookNames],
    });
    expect(stageStartHandler()).toBe(DECLARED_AT_IMPORT.onStageStart);
    expect(mergeHandler()).toBe(DECLARED_AT_IMPORT.onMerge);
    expect(Object.isFrozen(declared)).toBe(true);
    expect(Object.isFrozen(declared.hooks)).toBe(true);
  });

  it('leaves createDefaultRulesConfig carrying the default rules', () => {
    const rebuilt = createDefaultRulesConfig();

    expect(rebuilt.merge.canMerge).toBe(defaultCanMerge);
    expect(rebuilt.merge.produce).toBe(defaultProduceMergeValue);
    expect(Object.isFrozen(rebuilt)).toBe(false);
  });

  it('hands every test a fresh, writable rules object', () => {
    // Sections 3 through 6 each left a wrapper in force over their own bench.
    // This test runs after all of them and reads the default predicate, which
    // is what the beforeEach rebuild leaves in place.
    expect(bench.config.merge.canMerge).toBe(defaultCanMerge);
    expect(bench.config.merge.produce).toBe(defaultProduceMergeValue);
    expect(Object.isFrozen(bench.config)).toBe(false);
    expect(bench.effects.requested()).toEqual([]);
    expect(bench.chargeRequests).toBe(0);
  });
});
