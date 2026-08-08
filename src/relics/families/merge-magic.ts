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
// owns the charge guard and the decrement. `frostbind` ASKS for its charge
// through `HookContext.spendCharge()` on the merge its ledger toggles on, which
// is the one path its effect takes hold on; without that call the budget it
// declares was never spent and the relic fired for the whole run. No handler
// suppresses an error, so a throw reaches the bus, which reports it and marks
// the relic degraded.
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
//   DL-MERGE-01  all four relics bound to `onMerge` alone
//   DL-MERGE-02  `scoreDelta` transformed independently of `resultValue`,
//                as the two are separate payload members

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
 * Marker property `frostbind`'s installed predicate carries, so a stage that
 * begins against a predicate already wrapped installs no second wrapper.
 */
const FROSTBIND_PREDICATE_TAG = '__frostbindFrozenCells';

/**
 * Marker property `chain-catalyst`'s installed predicate carries. Distinct
 * from `FROSTBIND_PREDICATE_TAG`, so each wrapper is idempotent on its own and
 * the two compose.
 */
const CHAIN_CATALYST_PREDICATE_TAG = '__chainCatalystLadder';

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

/**
 * The merge predicate in force, falling back to the default of
 * src/config/default-config.ts where the rules carry none.
 *
 * The LIVE member is read rather than the default, so a wrapper installed over
 * it delegates to whatever another relic installed before it and the two
 * compose in pickup order.
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
 * The marker travels with the function it describes rather than living in a
 * state slot, because `createDefaultRulesConfig()` yields a fresh configuration
 * per run: a slot flag would suppress the re-install a reload genuinely needs,
 * while a marker on the predicate is absent exactly when the predicate is.
 *
 * The marker's VALUE is the delegate, which is what makes re-installation
 * idempotent: `taggedDelegate` unwraps a wrapper already in force, so a second
 * and a third installation replace the wrapper rather than nesting inside it.
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
 * The predicate a wrapper carrying `tag` should be built over: the delegate
 * recorded on the predicate in force where that predicate is already such a
 * wrapper, and the predicate in force itself otherwise.
 *
 * @param context Dispatch context, read for the predicate in force.
 * @param tag Marker property to unwrap.
 * @returns The predicate to delegate to.
 */
function taggedDelegate(context: HookContext, tag: string): MergePredicate {
  const live = predicateFor(context);
  const held: unknown = (live as TaggedPredicate)[tag];

  return typeof held === 'function' ? (held as MergePredicate) : live;
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
 * ledger does not hold, and thaws one it does — then re-records the frozen-cell
 * merge rule over the ledger the toggle produced.
 *
 * The rule is re-recorded because `MergePredicate` reaches no state slot: its
 * two operands are the merging tiles alone, so the ledger a predicate consults
 * is the ledger it was built over. Re-recording through `installFrostbind`
 * replaces the wrapper in force rather than wrapping it again, so the chain
 * never grows however many merges a stage resolves.
 *
 * Writes the ledger back through the context's own slot, as `{ x, y }` number
 * pairs that survive the envelope's serialisation, and returns nothing, which
 * leaves the merge resolving exactly as it arrived.
 *
 * ONE CHARGE PER TOGGLE. Frosting or thawing a cell is this relic's effect, so
 * the charge is asked for here and src/engine/hook-bus.ts spends it once the
 * handler's return has been accepted. `FROSTBIND_CHARGES` is therefore the
 * number of merges the relic acts on; once it is spent the bus's guard skips
 * both of the relic's bindings, so standing frost stops being traded for relief
 * as well.
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

  // ASKS FOR ITS CHARGE. The command recorded above would itself be enough for
  // the bus to count the invocation, but the toggle's effect is carried on the
  // state slot as much as on the rule, so the request is made explicitly rather
  // than left to be inferred: an invocation that toggled the ledger has acted
  // whether or not the rule was re-recordable. `spendCharge` is a request the bus
  // fulfils once — accumulated, never doubled — and only if this return is
  // accepted; this handler neither reads nor writes the budget.
  context.spendCharge();
}

/**
 * Reads the cell a merge operand stands in.
 *
 * `MergePredicate` declares its operands as `MergeTileView`, which carries a
 * face value and a merge record and no coordinates. The two callers supply
 * different objects: src/engine/move-resolver.ts L324 passes the live `Tile`
 * pair, whose `x` and `y` are the cells the merge resolves between, and
 * src/engine/terminal-state.ts L154 passes `probeView` value projections, which
 * carry none. The cell is therefore read structurally and is absent for a
 * neighbour probe.
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
 * `readCells` is called on every test rather than captured, so the rule the
 * resolver applies reads the ledger as `frostbindOnMerge` most recently left
 * it. A neighbour probe, whose operands carry no cell, is left to the
 * delegate's verdict alone: the loss check would otherwise report no moves
 * available on a board a later thaw reopens.
 *
 * The two operands arrive already existing — js/game_manager.js L156 kept the
 * `next &&` guard outside the equality test and src/engine/move-resolver.ts
 * keeps it outside `config.merge.canMerge` — so no operand-presence check is
 * made here.
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
 * Built over `taggedDelegate`, so the wrapper in force is REPLACED rather than
 * wrapped again: however many times this runs, exactly one frostbind wrapper
 * stands in the chain and the rules beneath it are untouched.
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
 * Every coordinate outside the stage's reconciled board is dropped first, so a
 * board that shrank between stages leaves no unreachable cell in the ledger.
 * The predicate is recorded through `HookContext.effects.setMergePredicate`,
 * which src/engine/board-effects.ts applies once this handler has returned.
 *
 * Returns nothing, so the stage's goal resolves exactly as it arrived.
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

/* --------------------------------------------------------------------------
 * chain-catalyst
 * ----------------------------------------------------------------------- */

/**
 * Builds the predicate `chain-catalyst` installs: the predicate in force, ALSO
 * accepting a pair whose values are adjacent on the doubling ladder — a pair
 * for which the producer in force, applied to the smaller operand, yields the
 * larger operand's value.
 *
 * The delegate's verdict is preserved as an OR and never replaced, so every
 * merge the rules already accept is still accepted.
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
 * Built over `taggedDelegate`, so a stage that begins against a rule this
 * relic already wrapped replaces that wrapper rather than nesting inside it,
 * and a reload — which yields a fresh configuration carrying the untagged
 * default — installs it again. Returns nothing, so the stage's goal resolves
 * exactly as it arrived.
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
 * src/engine/move-resolver.ts derives the value it dispatches from the moving
 * tile alone, which is what js/game_manager.js L157 did, so a pair of UNEQUAL
 * operands arrives carrying the wrong result. The corrected value is the
 * producer in force applied to the LARGER of the two operands.
 *
 * `scoreDelta` is raised BY the increment and never replaced by it, so what an
 * earlier handler on this hook accumulated survives — which is what makes the
 * pickup-order compounding of `echo-chamber` and this relic observable.
 *
 * An equal-valued pair, which is the ordinary vanilla merge, returns nothing,
 * so this relic alters no normal merge. A produced value that is not finite,
 * not positive, or not above the value the merge already carries returns
 * nothing too, which is the range src/engine/hook-bus.ts accepts a returned
 * `resultValue` in.
 *
 * Crossing `config.winValue` needs no handling here:
 * src/engine/terminal-state.ts owns that comparison against the live value.
 *
 * @param payload Merge being resolved.
 * @param context Dispatch context, read for the producer in force.
 * @returns The payload with `resultValue` and `scoreDelta` raised, or nothing.
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
