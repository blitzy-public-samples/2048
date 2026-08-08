// The `merge-magic` relic family: four relics acting at the merge point of a
// turn, each of the four bound to `onMerge`.
//
// Provenance is the vanilla merge branch js/game_manager.js L156-L170, which
// src/engine/move-resolver.ts ports and dispatches `onMerge` from:
//
//   L156  `next && next.value === tile.value && !next.mergedFrom`
//         -> `config.merge.canMerge`, applied at the resolver's merge test
//            with the `next &&` existence guard left outside it.
//   L157  `new Tile(positions.next, tile.value * 2)`
//         -> `config.merge.produce`, whose return the resolver carries into
//            the payload as `resultValue`.
//   L158  `merged.mergedFrom = [tile, next]`
//         -> the pair the payload's `source` and `target` project.
//   L167  `self.score += merged.value`
//         -> the payload's `scoreDelta`, which the resolver dispatches EQUAL
//            to `resultValue` as L167 held it, and which the handlers here
//            transform independently of the produced value.
//   L170  `merged.value === 2048`
//         -> `config.winValue`, compared in src/engine/terminal-state.ts,
//            which is where a raised `resultValue` resolves the win flag.
//
// One frozen `RelicFamily` is exported and nothing else. Each relic is plain
// data carrying the members src/relics/relic-types.ts declares, and behaviour
// lives in the handlers of its `hooks` table. The declaration order of
// `relics` is the catalogue order src/relics/relic-registry.ts flattens.
//
// A handler here reads every rule parameter from `HookContext.config` at use
// time, writes only the payload it returns and its own `state` slot, and
// never reads, compares or decrements a charge budget: src/engine/hook-bus.ts
// owns the charge guard and the decrement. No handler suppresses an error, so
// a throw reaches the bus, which reports it and marks the relic degraded.
//
// This module reads no DOM, performs no I/O, consumes no randomness, reads no
// clock and holds no mutable module state.
//
// Target rows TR-MERGE-01 through TR-MERGE-04 of docs/TRACEABILITY_MATRIX.md,
// one per relic in declaration order. Decisions behind this file are recorded
// in docs/DECISION_LOG.md.

import {
  defaultCanMerge,
  defaultProduceMergeValue,
} from '../../config/default-config';
import type { MergeProducer, MergeTileView } from '../../config/rules-config';
import type {
  HookContext,
  MergePayload,
  StageStartPayload,
} from '../../engine/hooks';
import type { Position } from '../../engine/types';
import type { Relic, RelicFamily } from '../relic-types';
import { RARITIES } from '../relic-types';

/* --------------------------------------------------------------------------
 * Relic magnitudes
 *
 * Intrinsic to the relics below and to no game rule: board size, win value,
 * spawn distribution and the merge rules are all read from the rules view on
 * `HookContext` at use time.
 * ----------------------------------------------------------------------- */

/**
 * Fraction of a merge's produced value `echo-chamber` adds to the score, over
 * and above the value the merge already scores.
 */
const ECHO_CHAMBER_SCORE_BONUS = 0.25;

/** Charge budget a run starts `frostbind` with. */
const FROSTBIND_CHARGES = 8;

/** The empty frosted-cell ledger `frostbind` starts a run with. */
const FROSTBIND_EMPTY_LEDGER: readonly Position[] = Object.freeze([]);

/**
 * Fraction of a stage's goal target `frostbind` eases it by for each cell
 * still frosted as the stage begins.
 */
const FROSTBIND_RELIEF_PER_CELL = 0.05;

/** Ceiling on the total relief `FROSTBIND_RELIEF_PER_CELL` accumulates to. */
const FROSTBIND_RELIEF_CEILING = 0.25;

/** Lowest goal target `frostbind` eases a stage down to. */
const FROSTBIND_MINIMUM_TARGET = 1;

/**
 * Which merges of a stage `chain-catalyst` catalyses: every third one,
 * counted from the first merge of the stage.
 */
const CHAIN_CATALYST_INTERVAL = 3;

/* --------------------------------------------------------------------------
 * State-slot readers
 *
 * A slot arrives as `unknown`: it round-trips through Web Storage inside the
 * run envelope as `PersistedRelic.state`. Each reader below narrows what it
 * finds and falls back to the relic's initial value rather than trusting the
 * shape, and each returns freshly built data, so writing what it returned
 * never reaches the slot the bus holds.
 * ----------------------------------------------------------------------- */

/**
 * Reports whether `value` is a plain object.
 *
 * @param value Value to test.
 * @returns `true` for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reports whether `value` is a non-negative safe integer.
 *
 * @param value Value to test.
 * @returns `true` for a non-negative safe integer.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reports whether `value` is an `{ x, y }` cell coordinate.
 *
 * @param value Value to test.
 * @returns `true` when both coordinates are non-negative safe integers.
 */
function isCell(value: unknown): value is Position {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.x) &&
    isNonNegativeInteger(value.y)
  );
}

/**
 * Reads `frostbind`'s frosted-cell ledger out of a state slot.
 *
 * @param state Slot as the bus handed it over.
 * @returns A fresh array of fresh coordinates, holding only the members that
 *   are cell coordinates, and empty where the slot carries no usable ledger.
 */
function readFrostedCells(state: unknown): Position[] {
  const ledger: unknown = isRecord(state) ? state.frozen : undefined;
  const held: readonly unknown[] = Array.isArray(ledger) ? ledger : [];
  const cells: Position[] = [];

  for (const cell of held) {
    if (isCell(cell)) {
      cells.push({ x: cell.x, y: cell.y });
    }
  }

  return cells;
}

/**
 * Reads `chain-catalyst`'s merge count out of a state slot.
 *
 * @param state Slot as the bus handed it over.
 * @returns The count, or `0` where the slot carries no usable one.
 */
function readMergeCount(state: unknown): number {
  const counted: unknown = isRecord(state) ? state.merges : undefined;

  return isNonNegativeInteger(counted) ? counted : 0;
}

/* --------------------------------------------------------------------------
 * Merge-rule access
 * ----------------------------------------------------------------------- */

/**
 * Projects a face value onto the operand shape the merge rules read, as
 * `probeView` of src/engine/terminal-state.ts projects a probed value: the
 * value alone, with no merge recorded against it.
 *
 * @param value Face value to project.
 * @returns A frozen operand carrying `value` and no merge history.
 */
function mergeOperand(value: number): MergeTileView {
  return Object.freeze({ value, mergedFrom: null });
}

/**
 * The merge producer in force, falling back to the default of
 * src/config/default-config.ts where the rules carry none.
 *
 * @param context Dispatch context, read for its rules view.
 * @returns The producer to apply.
 */
function producerFor(context: HookContext): MergeProducer {
  return context.config.merge.produce ?? defaultProduceMergeValue;
}

/* --------------------------------------------------------------------------
 * echo-chamber
 * ----------------------------------------------------------------------- */

/**
 * Adds `ECHO_CHAMBER_SCORE_BONUS` of the produced value to the score and
 * leaves the produced value itself alone, which is the separation of score
 * from value that L167 did not have.
 *
 * The bonus is floored to a whole point. The payload is returned unchanged
 * where the bonus does not reach one, and where the value it is taken from is
 * not finite, which is the range src/engine/hook-bus.ts accepts a returned
 * `scoreDelta` in.
 *
 * @param payload Merge being resolved.
 * @returns The payload with `scoreDelta` raised by the bonus.
 */
function echoChamberOnMerge(payload: MergePayload): MergePayload {
  const bonus = Math.floor(payload.resultValue * ECHO_CHAMBER_SCORE_BONUS);

  if (!Number.isFinite(bonus) || bonus <= 0) {
    return payload;
  }

  return { ...payload, scoreDelta: payload.scoreDelta + bonus };
}

/* --------------------------------------------------------------------------
 * alloy-forge
 * ----------------------------------------------------------------------- */

/**
 * Raises the produced value one further step, by applying the producer in
 * force to the value the merge already carries, and raises the score by the
 * increment.
 *
 * `scoreDelta` is raised BY the increment and never replaced by it: what an
 * earlier handler on this hook accumulated is carried into what this one
 * returns. The payload is returned unchanged where the producer does not yield
 * a finite value above the current one, which is the range
 * src/engine/hook-bus.ts accepts a returned `resultValue` in.
 *
 * @param payload Merge being resolved.
 * @param context Dispatch context, read for the producer in force.
 * @returns The payload with `resultValue` and `scoreDelta` raised.
 */
function alloyForgeOnMerge(
  payload: MergePayload,
  context: HookContext,
): MergePayload {
  const current = payload.resultValue;
  const operand = mergeOperand(current);
  const raised = producerFor(context)(operand, operand);

  if (!Number.isFinite(raised) || raised <= 0 || raised <= current) {
    return payload;
  }

  return {
    ...payload,
    resultValue: raised,
    scoreDelta: payload.scoreDelta + (raised - current),
  };
}

/* --------------------------------------------------------------------------
 * frostbind
 * ----------------------------------------------------------------------- */

/**
 * Toggles the destination cell in the frosted-cell ledger: frosts a cell the
 * ledger does not hold, and thaws one it does.
 *
 * Writes the ledger back through the context's own slot, as `{ x, y }` number
 * pairs that survive the envelope's serialisation, and returns nothing, which
 * leaves the merge resolving exactly as it arrived.
 *
 * @param payload Merge being resolved, read for the destination cell.
 * @param context Dispatch context, whose `state` slot carries the ledger.
 */
function frostbindOnMerge(payload: MergePayload, context: HookContext): void {
  const cells = readFrostedCells(context.state);
  const x = payload.target.x;
  const y = payload.target.y;
  const held = cells.findIndex((cell) => cell.x === x && cell.y === y);

  if (held < 0) {
    cells.push({ x, y });
  } else {
    cells.splice(held, 1);
  }

  context.state = { frozen: cells };
}

/**
 * Carries the ledger into a stage and eases that stage's goal by the frost
 * standing in it.
 *
 * Every coordinate outside the stage's reconciled board is dropped first, so a
 * board that shrank between stages leaves no unreachable cell in the ledger,
 * and the surviving cells then ease `goal.target` by
 * `FROSTBIND_RELIEF_PER_CELL` apiece, capped at `FROSTBIND_RELIEF_CEILING` and
 * floored at `FROSTBIND_MINIMUM_TARGET`. `goal.kind`, `stageIndex`, `seed` and
 * `boardSize` are carried across untouched, which is what
 * src/engine/hook-bus.ts holds a returned stage-start payload to.
 *
 * @param payload Stage being prepared.
 * @param context Dispatch context, whose `state` slot carries the ledger.
 * @returns The payload with an eased goal, or nothing where the ledger eases
 *   it by no whole point.
 */
function frostbindOnStageStart(
  payload: StageStartPayload,
  context: HookContext,
): StageStartPayload | void {
  const size = payload.boardSize;
  const cells = readFrostedCells(context.state).filter(
    (cell) => cell.x < size && cell.y < size,
  );

  context.state = { frozen: cells };

  const target = payload.goal.target;

  if (cells.length === 0 || !Number.isFinite(target)) {
    return;
  }

  const relief = Math.min(
    FROSTBIND_RELIEF_CEILING,
    cells.length * FROSTBIND_RELIEF_PER_CELL,
  );
  const eased = Math.max(
    FROSTBIND_MINIMUM_TARGET,
    Math.floor(target * (1 - relief)),
  );

  if (eased >= target) {
    return;
  }

  return { ...payload, goal: { ...payload.goal, target: eased } };
}

/* --------------------------------------------------------------------------
 * chain-catalyst
 * ----------------------------------------------------------------------- */

/**
 * Opens a stage with the merge count at zero, and returns nothing, so the
 * stage's goal resolves exactly as it arrived.
 *
 * @param _payload Stage being prepared, read for nothing.
 * @param context Dispatch context, whose `state` slot carries the count.
 */
function chainCatalystOnStageStart(
  _payload: StageStartPayload,
  context: HookContext,
): void {
  context.state = { merges: 0 };
}

/**
 * The face value one merge resolves to under `chain-catalyst`.
 *
 * A pair `defaultCanMerge` of src/config/default-config.ts does not accept —
 * two unequal values, which only a substituted predicate admits — resolves
 * from the LARGER of the two operands: L157 derived the value the resolver
 * dispatched from the moving tile alone. A pair it does accept
 * resolves one step up on every `CHAIN_CATALYST_INTERVAL`-th merge of the
 * stage, and to the value the merge already carries on every other.
 *
 * @param payload Merge being resolved.
 * @param produce Producer in force.
 * @param counted Position of this merge in the stage, counting from one.
 * @returns The face value the merge resolves to.
 */
function chainCatalystResult(
  payload: MergePayload,
  produce: MergeProducer,
  counted: number,
): number {
  const source = payload.source.value;
  const target = payload.target.value;

  if (!defaultCanMerge(mergeOperand(source), mergeOperand(target))) {
    const larger = mergeOperand(Math.max(source, target));

    return produce(larger, larger);
  }

  if (counted % CHAIN_CATALYST_INTERVAL === 0) {
    const carried = mergeOperand(payload.resultValue);

    return produce(carried, carried);
  }

  return payload.resultValue;
}

/**
 * Counts the merge into the stage's chain, and raises the merge where the
 * chain catalyses it.
 *
 * The count is written back through the context's own slot on every merge,
 * including one the chain leaves alone. `resultValue` is raised only to a
 * finite value above the one the merge carried, and `scoreDelta` is raised BY
 * the increment rather than replaced by it.
 *
 * @param payload Merge being resolved.
 * @param context Dispatch context, read for the producer in force and for the
 *   slot carrying the count.
 * @returns The payload with `resultValue` and `scoreDelta` raised, or nothing
 *   where this merge resolves as it arrived.
 */
function chainCatalystOnMerge(
  payload: MergePayload,
  context: HookContext,
): MergePayload | void {
  const counted = readMergeCount(context.state) + 1;

  context.state = { merges: counted };

  const current = payload.resultValue;
  const raised = chainCatalystResult(payload, producerFor(context), counted);

  if (!Number.isFinite(raised) || raised <= 0 || raised <= current) {
    return;
  }

  return {
    ...payload,
    resultValue: raised,
    scoreDelta: payload.scoreDelta + (raised - current),
  };
}

/* --------------------------------------------------------------------------
 * The four relics, in declaration order
 *
 * One to each ordinal position of `RARITIES`, and each carrying the members
 * `Relic` declares and no others. Frozen: a declaration is the template every
 * run shares, and the live per-run values are the bus's own.
 * ----------------------------------------------------------------------- */

/** Raises the score of every merge and leaves the merged tile alone. */
const echoChamber: Relic = Object.freeze({
  id: 'echo-chamber',
  name: 'Echo Chamber',
  rarity: RARITIES[0],
  description:
    'Every merge echoes, scoring an extra quarter of its value while the ' +
    'tile it produces stays exactly as it was.',
  hooks: Object.freeze({ onMerge: echoChamberOnMerge }),
});

/** Raises every merge one step higher and scores the value gained. */
const alloyForge: Relic = Object.freeze({
  id: 'alloy-forge',
  name: 'Alloy Forge',
  rarity: RARITIES[1],
  description:
    'Every merge is forged one step higher than the rules would yield, and ' +
    'the value it gains is added to your score as well.',
  hooks: Object.freeze({ onMerge: alloyForgeOnMerge }),
});

/** Frosts the cells merges land on, and trades standing frost for relief. */
const frostbind: Relic = Object.freeze({
  id: 'frostbind',
  name: 'Frostbind',
  rarity: RARITIES[2],
  description:
    'Each merge frosts the cell it lands on and a merge on a frosted cell ' +
    'thaws it again; frost still standing as a stage begins lowers that ' +
    "stage's goal.",
  hooks: Object.freeze({
    onStageStart: frostbindOnStageStart,
    onMerge: frostbindOnMerge,
  }),
  charges: FROSTBIND_CHARGES,
  state: Object.freeze({ frozen: FROSTBIND_EMPTY_LEDGER }),
});

/** Catalyses every third merge of a stage and resolves unequal pairs. */
const chainCatalyst: Relic = Object.freeze({
  id: 'chain-catalyst',
  name: 'Chain Catalyst',
  rarity: RARITIES[3],
  description:
    'Every third merge of a stage is catalysed one step higher, and a merge ' +
    'of unequal tiles yields from the larger of the pair; the value gained ' +
    'is scored as well.',
  hooks: Object.freeze({
    onStageStart: chainCatalystOnStageStart,
    onMerge: chainCatalystOnMerge,
  }),
  state: Object.freeze({ merges: 0 }),
});

/**
 * The `merge-magic` family: `echo-chamber`, `alloy-forge`, `frostbind` and
 * `chain-catalyst`, one to each ordinal position of `RARITIES`.
 *
 * The array order is the catalogue order src/relics/relic-registry.ts flattens
 * and src/relics/relic-draw.ts draws against, so it is stable and is not
 * rearranged. Frozen at every level this module owns.
 */
export const MERGE_MAGIC_FAMILY: RelicFamily = Object.freeze({
  name: 'merge-magic',
  relics: Object.freeze([echoChamber, alloyForge, frostbind, chainCatalyst]),
});

