// The `merge-magic` relic family: four relics acting at the merge point of a
// turn, each of the four bound to `onMerge`.
//
// Provenance is the vanilla merge branch js/game_manager.js L156-L170, which
// src/engine/move-resolver.ts ports and dispatches `onMerge` from.
//
// CHANGED: one frozen `RelicFamily` and one standing-rule reinstatement
// function are exported, where the family export was the whole surface. Each
// relic is plain
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
//   TR-MERGE-06  `reinstateFrostbindRule`, the non-hook reinstatement of the
//                frozen-cell rule on rehydrated rules
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-MERGE-01  every relic bound to `onMerge` for its effect, with
//                `frostbind` and `chain-catalyst` binding `onStageStart` as
//                well to clear the state each keeps for a stage
//   DL-MERGE-02  `scoreDelta` transformed independently of `resultValue`,
//                as the two are separate payload members
//   DL-MERGE-03  `chain-catalyst`'s ladder branch refusing a target that
//                already merged this traversal and inheriting any structural
//                denial its delegate made, so the widening reaches values and
//                neither turn structure nor another relic's rule
//   DL-MERGE-04  `frostbind` thawing the cell a merge moved OUT of, which is
//                the transition the rule it installs leaves reachable
//   DL-MERGE-05  `reinstateFrostbindRule`, reached from the rehydration path
//                rather than from a hook, so an exhausted relic dispatches
//                nothing while the frost it already paid for survives a reload

import {
  defaultCanMerge,
  defaultProduceMergeValue,
} from '../../config/default-config';
import type {
  MergePredicate,
  MergeProducer,
  MergeRules,
  MergeTileView,
  RulesConfig,
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
 * Removes one cell from a frosted-cell ledger, in place.
 *
 * @param cells Ledger to thaw from.
 * @param cell Cell to thaw.
 * @returns Whether the ledger held it.
 */
function thawCell(cells: Position[], cell: Position): boolean {
  const held = cells.findIndex(
    (frosted) => frosted.x === cell.x && frosted.y === cell.y,
  );

  if (held < 0) {
    return false;
  }

  cells.splice(held, 1);

  return true;
}

/**
 * Resolves one merge against the frosted-cell ledger: THAWS the cell the merge
 * moved out of, then toggles the cell it landed on — frosting one the ledger
 * does not hold and thawing one it does — and re-records the frozen-cell merge
 * rule over the ledger those two steps produced.
 *
 * ADDED: the thaw of `payload.source`. The only thaw the relic had was the
 * destination toggle below, and the rule it installs refuses precisely the merge
 * that would reach it — a merge INTO a frosted cell — so no legal move could
 * ever thaw anything and a frosted cell stayed frosted for the rest of the run.
 * The installed rule constrains the merge's DESTINATION and never its source, so
 * a frosted cell whose tile slides out and merges elsewhere is reachable by
 * ordinary play, and that is the transition the frost is released on.
 *
 * The destination toggle is KEPT: it is the branch that frosts, and its thaw
 * half remains the defined answer where a merge does land on a frosted cell
 * because a later relic replaced the merge rule outright rather than wrapping it.
 *
 * DL-MERGE-04.
 *
 * @param payload Merge being resolved, read for both cells it spans.
 * @param context Dispatch context, whose `state` slot carries the ledger and
 *   whose effect queue records the rule.
 */
function frostbindOnMerge(payload: MergePayload, context: HookContext): void {
  const cells = readFrostedCells(context.state);

  thawCell(cells, { x: payload.source.x, y: payload.source.y });

  const destination = { x: payload.target.x, y: payload.target.y };

  if (!thawCell(cells, destination)) {
    cells.push(destination);
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
 * Projects one operand carrying a substituted face value.
 *
 * ADDED for the structural-denial probe of `chainCatalystPredicate`. Every member
 * the operand declares beyond its value travels across — the cell where it
 * carries one and the merge history either way — so a delegate keyed on position
 * or on merge history answers the probe from its own rule rather than from a
 * no-position fall-through, exactly as `probeView` of
 * src/engine/terminal-state.ts carries a cell for the same reason.
 *
 * @param operand Operand to project.
 * @param value Face value the projection carries.
 * @returns A frozen operand at `value`, standing where `operand` stands.
 */
function operandAtValue(operand: MergeTileView, value: number): MergeTileView {
  const cell = operandCell(operand);
  const projected = { value, mergedFrom: operand.mergedFrom };

  return Object.freeze(
    cell === null ? projected : { ...projected, x: cell.x, y: cell.y },
  );
}

/**
 * ADDED: reinstates `frostbind`'s frozen-cell merge rule on a set of rules
 * REHYDRATED from a persisted slot, dispatching nothing.
 *
 * A reload builds fresh rules carrying the default merge predicate, so the
 * wrapper an earlier session installed is gone while the frosted cells that
 * session persisted are not. This is the non-hook path that puts the wrapper
 * back: it is handed the slot and the live rules by
 * `applyStandingRelicRules` of ../relic-registry and never sees a hook, a
 * dispatch context or a charge budget — so a budget spent long ago neither
 * withholds the reinstatement nor is charged for it, and no exhausted handler
 * runs. Cells outside the rehydrated board are dropped, as the stage-start
 * install drops them. `DL-MERGE-05`.
 *
 * @param state Slot as `RunState.relics[i].state` carried it.
 * @param rules Live rules to write the predicate into.
 * @returns Whether a predicate was installed, which is `false` only where
 *   `rules` carries no writable merge member.
 */
export function reinstateFrostbindRule(
  state: unknown,
  rules: RulesConfig,
): boolean {
  const merge: MergeRules | undefined = rules.merge;

  if (merge === undefined || merge === null) {
    return false;
  }

  const size = rules.boardSize;
  const bounded = Number.isFinite(size) ? size : 0;
  const cells = readFrostedCells(state).filter(
    (cell) => cell.x < bounded && cell.y < bounded,
  );
  const live = merge.canMerge ?? defaultCanMerge;
  const held: unknown = (live as TaggedPredicate)[FROSTBIND_PREDICATE_TAG];

  // The wrapper a previous install left behind is REPLACED rather than wrapped
  // a second time, exactly as `taggedDelegate` replaces one during a dispatch.
  merge.canMerge = frostbindPredicate(
    typeof held === 'function' ? (held as MergePredicate) : live,
    (): readonly Position[] => cells,
  );

  return true;
}

/**
 * Builds the predicate `chain-catalyst` installs: the predicate in force, ALSO
 * accepting a pair whose values are adjacent on the doubling ladder — a pair
 * for which the producer in force, applied to the smaller operand, yields the
 * larger operand's value.
 *
 * The delegate's verdict is preserved as an OR and never replaced, so every
 * merge the rules already accept is still accepted.
 *
 * THE ONE-MERGER-PER-TRAVERSAL GUARD IS PRESERVED. js/game_manager.js L156 held
 * `!next.mergedFrom` beside its equality test, and src/engine/move-resolver.ts
 * L313 assigns `mergedFrom` to the tile a merge produced, so a target carrying
 * it has already merged during the traversal in progress. The ladder branch
 * refuses such a target: this relic widens WHICH VALUES may merge and nothing
 * else. Without the refusal a produced tile merged a second time in one move.
 *
 * ADDED: A STRUCTURAL DENIAL THE DELEGATE MADE IS INHERITED, NOT OVERRIDDEN.
 * The ladder branch treated every refusal the delegate returned as a refusal
 * about the two face values, so wrapping a delegate that refuses on some OTHER
 * ground — `frostbind`'s wrapper refuses by destination CELL — widened past that
 * ground and admitted a merge onto a frozen cell whenever the pair happened to
 * be a ladder step apart. The two grounds are told apart by asking the delegate
 * the same question with the pair made value-COMPATIBLE: a delegate that still
 * refuses the equal-valued pair standing in the same cells with the same merge
 * history is refusing structurally, and its refusal stands. The probe reads the
 * delegate alone and names no relic, so it composes against any predicate a
 * later relic installs.
 *
 * The two operands arrive already existing — js/game_manager.js L156 kept the
 * `next &&` guard outside the equality test and src/engine/move-resolver.ts
 * keeps it outside `config.merge.canMerge` — so no operand-presence check is
 * made here.
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

    if (produce(operand, operand) !== high) {
      return false;
    }

    // THE INHERITED-DENIAL PROBE. The pair is value-compatible for this relic;
    // whether it is admissible at all is still the delegate's to say, and it is
    // asked with the value difference — the one ground this relic widens —
    // removed.
    return delegate(operandAtValue(moving, target.value), target);
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
    'on a frozen cell until the tile standing there merges away. ' +
    'Limited charges.',
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
