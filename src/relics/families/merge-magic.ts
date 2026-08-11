// The `merge-magic` relic family: four relics acting at the merge point of a
// turn, each of the four bound to `onMerge`.
//
// Provenance is the vanilla merge branch js/game_manager.js L156-L170, which
// src/engine/move-resolver.ts ports and dispatches `onMerge` from.
//
// One frozen `RelicFamily` is exported and nothing else. Each relic is plain
// data carrying the members src/relics/relic-types.ts declares, and behaviour
// lives in the handlers of its `hooks` table. The declaration order of
// `relics` is the catalogue order src/relics/relic-registry.ts flattens.
//
// This module reads no DOM, performs no I/O, consumes no randomness, reads no
// clock and holds no mutable module state.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, in declaration
// order, all target-only because no vanilla construct declared a relic:
//   TR-MERGE-01  echo-chamber      onMerge
//   TR-MERGE-02  alloy-forge       onMerge
//   TR-MERGE-03  frostbind         onMerge
//   TR-MERGE-04  chain-catalyst    onMerge
//   TR-MERGE-05  the frozen `MERGE_MAGIC_FAMILY` export
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-MERGE-01  every relic bound to `onMerge` for its effect, with
//                `frostbind` and `chain-catalyst` binding `onStageStart` as
//                well to clear the state each keeps for a stage
//   DL-MERGE-02  `scoreDelta` transformed independently of `resultValue`,
//                as the two are separate payload members
//   DL-MERGE-03  `chain-catalyst`'s ladder branch refusing a target that
//                already merged this traversal, so the widening reaches values
//                and not turn structure

import {
  defaultCanMerge,
  defaultProduceMergeValue,
} from '../../config/default-config';
import type {
  MergePredicate,
  MergeProducer,
  MergeTileView,
} from '../../config/rules-config';
import type {
  HookContext,
  MergePayload,
  StageStartPayload,
} from '../../engine/hooks';
import type { Position } from '../../engine/types';
import type { Relic, RelicFamily } from '../relic-types';
import { RARITIES } from '../relic-types';

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
 * Marker property `frostbind`'s installed predicate carries, so a stage that
 * begins against a predicate already wrapped installs no second wrapper.
 */
const FROSTBIND_PREDICATE_TAG = '__frostbindFrozenCells';

/** Marker property `chain-catalyst`'s installed predicate carries. */
const CHAIN_CATALYST_PREDICATE_TAG = '__chainCatalystLadder';

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
 * Projects a face value onto the operand shape the merge rules read: the value
 * alone, with no merge recorded against it.
 *
 * NO CELL is carried, and none is needed: every caller hands the operand to the
 * merge PRODUCER, which is a function of the two face values, and never to the
 * position-aware predicate. `probeView` of src/engine/terminal-state.ts does
 * carry a cell, because it feeds the predicate.
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

/**
 * The merge predicate in force, falling back to the default of
 * src/config/default-config.ts where the rules carry none.
 *
 * @param context Dispatch context, read for its rules view.
 * @returns The predicate to delegate to.
 */
function predicateFor(context: HookContext): MergePredicate {
  return context.config.merge.canMerge ?? defaultCanMerge;
}

/** One merge predicate carrying the marker property a wrapper writes. */
type TaggedPredicate = MergePredicate & Record<string, unknown>;

/**
 * Marks a wrapper with `tag`, recording under that marker the predicate the
 * wrapper delegates to, and hands the wrapper back.
 *
 * @param wrapper Wrapper to mark.
 * @param tag Marker property to write.
 * @param delegate Predicate the wrapper delegates to.
 * @returns The same wrapper, now carrying the marker.
 */
function withTag(
  wrapper: MergePredicate,
  tag: string,
  delegate: MergePredicate,
): MergePredicate {
  Object.defineProperty(wrapper, tag, {
    value: delegate,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return wrapper;
}

/**
 * @param context Dispatch context, read for the predicate in force.
 * @param tag Marker property to unwrap.
 * @returns The predicate to delegate to.
 */
function taggedDelegate(context: HookContext, tag: string): MergePredicate {
  const live = predicateFor(context);
  const held: unknown = (live as TaggedPredicate)[tag];

  return typeof held === 'function' ? (held as MergePredicate) : live;
}

/**
 * Adds `ECHO_CHAMBER_SCORE_BONUS` of the produced value to the score and
 * leaves the produced value itself alone, which is the separation of score
 * from value that L167 did not have.
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

/**
 * Raises the produced value one further step, by applying the producer in
 * force to the value the merge already carries, and raises the score by the
 * increment.
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

/**
 * Toggles the destination cell in the frosted-cell ledger: frosts a cell the
 * ledger does not hold, and thaws one it does — then re-records the
 * frozen-cell merge rule over the ledger the toggle produced.
 *
 * @param payload Merge being resolved, read for the destination cell.
 * @param context Dispatch context, whose `state` slot carries the ledger and
 *   whose effect queue records the rule.
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
  installFrostbind(context, cells);

  // Asks for its charge.
  context.spendCharge();
}

/**
 * Reads the cell a merge operand stands in.
 *
 * @param operand Operand as the predicate received it.
 * @returns A fresh cell, or `null` where the operand carries none.
 */
function operandCell(operand: MergeTileView): Position | null {
  const candidate = operand as { x?: unknown; y?: unknown };

  if (!isNonNegativeInteger(candidate.x)) {
    return null;
  }

  if (!isNonNegativeInteger(candidate.y)) {
    return null;
  }

  return { x: candidate.x, y: candidate.y };
}

/**
 * Builds the predicate `frostbind` installs: the predicate in force, refusing
 * in addition a merge whose destination cell stands in the ledger.
 *
 * @param delegate Predicate in force, whose verdict is required.
 * @param readCells Reads the frosted-cell ledger.
 * @returns The tagged predicate to install.
 */
function frostbindPredicate(
  delegate: MergePredicate,
  readCells: () => readonly Position[],
): MergePredicate {
  const wrapper: MergePredicate = (moving, target): boolean => {
    if (!delegate(moving, target)) {
      return false;
    }

    const destination = operandCell(target);

    if (destination === null) {
      return true;
    }

    return !readCells().some(
      (cell) => cell.x === destination.x && cell.y === destination.y,
    );
  };

  return withTag(wrapper, FROSTBIND_PREDICATE_TAG, delegate);
}

/**
 * Records the frozen-cell merge rule over the ledger `cells` holds.
 *
 * @param context Dispatch context, whose effect queue records the predicate.
 * @param cells Ledger the recorded predicate reads.
 */
function installFrostbind(
  context: HookContext,
  cells: readonly Position[],
): void {
  context.effects.setMergePredicate(
    frostbindPredicate(
      taggedDelegate(context, FROSTBIND_PREDICATE_TAG),
      (): readonly Position[] => cells,
    ),
  );
}

/**
 * Carries the ledger into a stage and installs the frozen-cell merge rule.
 *
 * @param payload Stage being prepared, read for the reconciled board size.
 * @param context Dispatch context, whose `state` slot carries the ledger and
 *   whose effect queue installs the predicate.
 */
function frostbindOnStageStart(
  payload: StageStartPayload,
  context: HookContext,
): void {
  const size = payload.boardSize;
  const cells = readFrostedCells(context.state).filter(
    (cell) => cell.x < size && cell.y < size,
  );

  context.state = { frozen: cells };
  installFrostbind(context, cells);
}

/**
 * Builds the predicate `chain-catalyst` installs: the predicate in force, ALSO
 * accepting a pair whose values are adjacent on the doubling ladder — a pair
 * for which the producer in force, applied to the smaller operand, yields the
 * larger operand's value.
 *
 * @param delegate Predicate in force, whose acceptance is preserved.
 * @param produce Producer the ladder step is measured with.
 * @returns The tagged predicate to install.
 */
function chainCatalystPredicate(
  delegate: MergePredicate,
  produce: MergeProducer,
): MergePredicate {
  const wrapper: MergePredicate = (moving, target): boolean => {
    if (delegate(moving, target)) {
      return true;
    }

    // THE ONE-MERGER-PER-TRAVERSAL GUARD, restated on the widened branch.
    // js/game_manager.js L156 held `!next.mergedFrom` beside the equality test,
    // so a tile produced by a merge earlier in the same traversal is never
    // merged into again. The delegate enforces that for an equal-valued pair and
    // refuses this one for the recorded merge alone, so widening on the two face
    // values without repeating the guard admitted a second merge into the same
    // target within one turn. The widening adds a pair the rules would otherwise
    // refuse; it does not relax a rule the vanilla game froze.
    if (target.mergedFrom) {
      return false;
    }

    const low = Math.min(moving.value, target.value);
    const high = Math.max(moving.value, target.value);

    if (!Number.isFinite(low) || low <= 0 || low === high) {
      return false;
    }

    const operand = mergeOperand(low);

    return produce(operand, operand) === high;
  };

  return withTag(wrapper, CHAIN_CATALYST_PREDICATE_TAG, delegate);
}

/**
 * Opens a stage by installing the adjacent-ladder merge rule.
 *
 * @param _payload Stage being prepared, read for nothing.
 * @param context Dispatch context, read for the rules in force and whose
 *   effect queue records the predicate.
 */
function chainCatalystOnStageStart(
  _payload: StageStartPayload,
  context: HookContext,
): void {
  context.effects.setMergePredicate(
    chainCatalystPredicate(
      taggedDelegate(context, CHAIN_CATALYST_PREDICATE_TAG),
      producerFor(context),
    ),
  );
}

/**
 * Corrects the produced value of a merge the adjacent-ladder rule admitted.
 *
 * @param payload Merge being resolved.
 * @param context Dispatch context, read for the producer in force.
 * @returns The payload with `resultValue` and `scoreDelta` raised, or
 *   nothing.
 */
function chainCatalystOnMerge(
  payload: MergePayload,
  context: HookContext,
): MergePayload | void {
  const source = payload.source.value;
  const target = payload.target.value;

  if (source === target) {
    return;
  }

  const larger = mergeOperand(Math.max(source, target));
  const current = payload.resultValue;
  const raised = producerFor(context)(larger, larger);

  if (!Number.isFinite(raised) || raised <= 0 || raised <= current) {
    return;
  }

  return {
    ...payload,
    resultValue: raised,
    scoreDelta: payload.scoreDelta + (raised - current),
  };
}

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

/** Freezes the cells merges land on, refusing further merges there. */
const frostbind: Relic = Object.freeze({
  id: 'frostbind',
  name: 'Frostbind',
  rarity: RARITIES[2],
  description:
    'Each merge freezes the cell it lands on, and no further merge resolves ' +
    'on a frozen cell until another merge there thaws it. Limited charges.',
  hooks: Object.freeze({
    onStageStart: frostbindOnStageStart,
    onMerge: frostbindOnMerge,
  }),
  charges: FROSTBIND_CHARGES,
  state: Object.freeze({ frozen: FROSTBIND_EMPTY_LEDGER }),
});

/** Lets neighbours one step apart on the ladder merge into the larger. */
const chainCatalyst: Relic = Object.freeze({
  id: 'chain-catalyst',
  name: 'Chain Catalyst',
  rarity: RARITIES[3],
  description:
    'Tiles one step apart on the doubling ladder now merge, yielding from ' +
    'the larger of the pair, and the value gained is scored as well.',
  hooks: Object.freeze({
    onStageStart: chainCatalystOnStageStart,
    onMerge: chainCatalystOnMerge,
  }),
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
