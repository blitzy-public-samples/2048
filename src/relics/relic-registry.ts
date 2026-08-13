// The relic registry: the assembled catalogue, the pickup-ordered relics one
// run holds, and the conversion to and from the persisted triple.
//
// The front door of src/relics/. This module imports the four family modules
// and owns the flattened catalogue, and it is the only construct that knows a
// relic exists. Adding a relic is an edit to a family module and to nothing
// here.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-REGISTRY-01  js/game_manager.js L9-L11    the three fixed subscriptions
//                                                generalised into pickup-
//                                                ordered hook subscriptions
//   TR-REGISTRY-02  js/game_manager.js L102-L110 `serialize()`
//   TR-REGISTRY-03  js/game_manager.js L36-L45   `restore()`, the guarded
//                                                rehydration branch
//   TR-REGISTRY-04  target-only row              `RELIC_CATALOGUE`,
//                                                `findRelicById` and the
//                                                assembled family pool
//   TR-REGISTRY-05  target-only row              `STANDING_RELIC_RULES` and
//                                                `applyStandingRelicRules`,
//                                                the non-hook reinstatement of
//                                                a standing rule on rehydrated
//                                                rules
//
// Decisions: DL-REGISTRY-01, DL-REGISTRY-02, DL-REGISTRY-03, DL-REGISTRY-04
// (docs/DECISION_LOG.md).

import {
  RARITIES,
  RELIC_FAMILY_NAMES,
  type ActiveRelic,
  type PersistedRelic,
  type Rarity,
  type Relic,
  type RelicFamily,
  type RelicFamilyName,
  type RelicHooks,
} from './relic-types';
import type { RulesConfig } from '../config/rules-config';
import { HOOK_NAMES } from '../engine/hooks';
import { BOARD_MANIPULATION_FAMILY } from './families/board-manipulation';
import {
  MERGE_MAGIC_FAMILY,
  reinstateFrostbindRule,
} from './families/merge-magic';
import { RISK_REWARD_CURSED_FAMILY } from './families/risk-reward-cursed';
import { SPAWN_CONTROL_FAMILY } from './families/spawn-control';
import type {
  ChargeConsumption,
  HookBus,
  HookSubscriber,
} from '../engine/hook-bus';
import {
  EMPTY_RELIC_CONTEXT,
  NOOP_ENGINE_REPORTER,
  correlationReader,
  type CorrelationId,
  type CorrelationSource,
  type EngineReporter,
  type RelicCommitContext,
  type RelicCommitContextProvider,
  type RelicCommitEntry,
} from '../engine/types';

// Reported through `EngineReporter.onCount`, in the
// `<subsystem>.<area>.<event>` form src/engine/hook-bus.ts and src/input/ use.

const CATALOGUE_DUPLICATE_METRIC = 'relics.catalogue.duplicate';

const PICKUP_METRIC = 'relics.pickup';

const PICKUP_UNKNOWN_METRIC = 'relics.pickup.unknown';

const PICKUP_HELD_METRIC = 'relics.pickup.held';

const REGISTER_REFUSED_METRIC = 'relics.register.refused';

const RESTORE_METRIC = 'relics.restore';

const RESTORE_UNKNOWN_METRIC = 'relics.restore.unknown';

const RESTORE_MALFORMED_METRIC = 'relics.restore.malformed';

const RESTORE_REJECTED_METRIC = 'relics.restore.rejected';

const CLEARED_METRIC = 'relics.cleared';

/**
 * ADDED: counter raised with the number of standing rules a restore
 * reinstated on the live rules. `DL-REGISTRY-04`.
 */
const STANDING_RULE_METRIC = 'relics.standing_rule.reinstated';

/** Counter raised for an activation that reached the bus. */
const ACTIVATE_METRIC = 'relics.activate';

/**
 * Counter raised for an activation naming nothing held: an identifier no held
 * relic carries, or a pickup position past the relics held.
 */
const ACTIVATE_UNKNOWN_METRIC = 'relics.activate.unknown';

const ACTIVATE_REFUSED_METRIC = 'relics.activate.refused';

/**
 * Counter raised for an activation the bus took nothing for: a relic whose
 * budget is already spent, and a relic carrying no budget at all.
 */
const ACTIVATE_EXHAUSTED_METRIC = 'relics.activate.exhausted';

/**
 * Nesting depth a state slot is copied to, matching `MAX_STATE_DEPTH` of
 * src/engine/hook-bus.ts and `MAX_RELIC_STATE_DEPTH` of src/run/run-state.ts.
 */
const MAX_STATE_DEPTH = 8;

/** Members one level of a state slot will carry. */
const MAX_STATE_MEMBERS = 256;

/**
 * Names a copied state slot never carries, matching `RESERVED_STATE_KEYS` of
 * src/run/run-state.ts.
 */
const RESERVED_STATE_KEYS: ReadonlySet<string> = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Entries `restore` reads from one persisted array, matching
 * `MAX_PERSISTED_RELICS` of src/run/run-state.ts.
 */
const MAX_RESTORED_ENTRIES = 64;

/** The empty frozen array every identifier accessor falls back to. */
const NO_IDS: readonly string[] = Object.freeze([]);

/**
 * What `activate` reports for a target no held relic answers to: nothing is
 * held, nothing is charge-limited, nothing was spent and no identifier was
 * addressed.
 */
const REFUSED_ACTIVATION: RelicActivation = Object.freeze({
  held: false,
  limited: false,
  consumed: 0,
  remaining: undefined,
  relicId: null,
});

/**
 * Reports whether one value is an array, containing the reflection a revoked
 * `Proxy` raises from.
 *
 * @param value Value to test.
 * @returns `true` for an array, and `false` where the test itself raised.
 */
function isArrayValue(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * Reports whether `value` is a plain object: an object that is neither `null`
 * nor an array.
 *
 * @param value Value to test.
 * @returns `true` for a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !isArrayValue(value);
}

/**
 * Reports whether `value` is a number that is neither `NaN` nor an infinity.
 *
 * @param value Value to test.
 * @returns `true` for a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reports whether `value` is one of the rarities `RARITIES` declares.
 *
 * @param value Value to test.
 * @returns `true` for a declared rarity.
 */
function isRarity(value: unknown): value is Rarity {
  return (
    typeof value === 'string' &&
    (RARITIES as readonly string[]).includes(value)
  );
}

/**
 * Reads one data member of a state slot.
 *
 * @param source Object to read.
 * @param name Own property to read.
 * @returns The stored value, or `undefined` for an absent property, for an
 *   accessor, and for a member whose descriptor could not be read.
 */
function readDataMember(source: object, name: string): unknown {
  let descriptor: PropertyDescriptor | undefined;

  try {
    descriptor = Object.getOwnPropertyDescriptor(source, name);
  } catch {
    return undefined;
  }

  if (
    descriptor === undefined ||
    typeof descriptor.get === 'function' ||
    typeof descriptor.set === 'function'
  ) {
    return undefined;
  }

  return descriptor.value;
}

/**
 * Lists the own member names of one state level.
 *
 * @param source Object to enumerate.
 * @returns The own string-keyed names, and an empty list where they could
 *   not be read.
 */
function readMemberNames(source: object): readonly string[] {
  try {
    return Object.getOwnPropertyNames(source);
  } catch {
    return NO_IDS;
  }
}

/**
 * Reads the length of one array level of a state slot.
 *
 * @param entries Array to measure.
 * @returns The length as a whole number at or above zero, and `0` where it
 *   could not be read or is not a finite number.
 */
function readEntryCount(entries: readonly unknown[]): number {
  let length: unknown;

  try {
    length = entries.length;
  } catch {
    return 0;
  }

  return isFiniteNumber(length) ? Math.max(0, Math.trunc(length)) : 0;
}

/**
 * Reads one element of an array level of a state slot.
 *
 * @param entries Array to read.
 * @param index Element to read.
 * @returns The element, and `undefined` where the read raised.
 */
function readEntry(entries: readonly unknown[], index: number): unknown {
  try {
    return entries[index];
  } catch {
    return undefined;
  }
}

/**
 * Copies the entries of one array level of a state slot.
 *
 * @param entries Level to copy.
 * @param depth Levels already descended.
 * @returns A fresh array, `null` standing in for each entry JSON cannot
 *   carry, exactly as `JSON.stringify` writes one.
 */
function copyStateEntries(
  entries: readonly unknown[],
  depth: number,
): unknown[] {
  const copied: unknown[] = [];
  const length = Math.min(readEntryCount(entries), MAX_STATE_MEMBERS);

  for (let index = 0; index < length; index += 1) {
    copied.push(copyRelicState(readEntry(entries, index), depth + 1) ?? null);
  }

  return copied;
}

/**
 * Copies the members of one object level of a state slot.
 *
 * @param source Level to copy.
 * @param depth Levels already descended.
 * @returns A fresh prototype-less object carrying the members that survive
 *   the copy.
 */
function copyStateMembers(
  source: object,
  depth: number,
): Record<string, unknown> {
  const copied = Object.create(null) as Record<string, unknown>;
  let kept = 0;

  for (const name of readMemberNames(source)) {
    if (kept >= MAX_STATE_MEMBERS) {
      break;
    }

    if (RESERVED_STATE_KEYS.has(name)) {
      continue;
    }

    const member = copyRelicState(readDataMember(source, name), depth + 1);

    if (member !== undefined) {
      Object.defineProperty(copied, name, {
        value: member,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      kept += 1;
    }
  }

  return copied;
}

/**
 * Copies one state slot, all the way down.
 *
 * @param value Slot to copy.
 * @param depth Levels already descended.
 * @returns A copy sharing no object with `value`.
 */
function copyRelicState(value: unknown, depth = 0): unknown {
  if (value === null) {
    return null;
  }

  const kind = typeof value;

  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return value;
  }

  if (kind !== 'object' || depth >= MAX_STATE_DEPTH) {
    return undefined;
  }

  if (isArrayValue(value)) {
    return copyStateEntries(value, depth);
  }

  return copyStateMembers(value as object, depth);
}

/**
 * Normalises one charge budget to a whole number within `[0,
 * Number.MAX_SAFE_INTEGER]`.
 *
 * @param value Budget to normalise.
 * @returns The normalised budget; `0` for a value that is not finite and for
 *   one at or below zero.
 */
function normaliseCharges(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(Math.max(0, Math.trunc(value)), Number.MAX_SAFE_INTEGER);
}

/** The four family records as their modules export them, before ordering. */
const DECLARED_FAMILIES: readonly RelicFamily[] = [
  SPAWN_CONTROL_FAMILY,
  MERGE_MAGIC_FAMILY,
  BOARD_MANIPULATION_FAMILY,
  RISK_REWARD_CURSED_FAMILY,
];

/**
 * Removes the family named `name` from `pool` and returns it.
 *
 * @param pool Families not yet ordered; the match is spliced out of it.
 * @param name Family to take.
 * @returns The family, or `undefined` where `pool` holds none of that name.
 */
function takeFamily(
  pool: RelicFamily[],
  name: RelicFamilyName,
): RelicFamily | undefined {
  for (let index = 0; index < pool.length; index += 1) {
    if (pool[index].name === name) {
      return pool.splice(index, 1)[0];
    }
  }

  return undefined;
}

/**
 * Orders family records by `RELIC_FAMILY_NAMES`.
 *
 * @param families Families to order.
 * @returns A fresh array in ladder order.
 */
function orderFamilies(families: readonly RelicFamily[]): RelicFamily[] {
  const pool = families.slice();
  const ordered: RelicFamily[] = [];

  for (const name of RELIC_FAMILY_NAMES) {
    const family = takeFamily(pool, name);

    if (family !== undefined) {
      ordered.push(family);
    }
  }

  return ordered.concat(pool);
}

/**
 * Freezes one relic declaration and its handler table.
 *
 * @param relic Declaration to freeze.
 * @returns The same object, frozen.
 */
function freezeRelic(relic: Relic): Relic {
  Object.freeze(relic.hooks);

  return Object.freeze(relic);
}

/**
 * Copies the handler table of a declaration this registry did not author.
 *
 * @param table Table to copy.
 * @returns A fresh frozen table.
 */
function adoptHooks(table: object): RelicHooks {
  const adopted: Record<string, unknown> = {};

  for (const hook of HOOK_NAMES) {
    const handler = readDataMember(table, hook);

    if (typeof handler === 'function') {
      adopted[hook] = handler;
    }
  }

  return Object.freeze(adopted) as RelicHooks;
}

/**
 * Adopts one relic declaration this registry did not author: an injected
 * catalogue entry, or a declaration handed straight to `pickUp`.
 *
 * @param relic Declaration to adopt, already known to carry a usable shape.
 * @returns A fresh frozen declaration.
 */
function adoptDefinition(relic: Relic): Relic {
  const source: object = relic;
  const id = readDataMember(source, 'id');
  const table = readDataMember(source, 'hooks');
  const charges = readDataMember(source, 'charges');
  const name = readDataMember(source, 'name');
  const rarity = readDataMember(source, 'rarity');
  const description = readDataMember(source, 'description');
  const identifier = typeof id === 'string' ? id : '';

  const adopted: {
    id: string;
    name: string;
    rarity: Rarity;
    description: string;
    hooks: RelicHooks;
    charges?: number;
    state?: unknown;
  } = {
    id: identifier,
    name: typeof name === 'string' ? name : identifier,
    rarity: isRarity(rarity) ? rarity : RARITIES[0],
    description: typeof description === 'string' ? description : '',
    hooks: adoptHooks(isRecord(table) ? table : {}),
  };

  if (charges !== undefined) {
    adopted.charges = normaliseCharges(
      isFiniteNumber(charges) ? charges : 0,
    );
  }

  const state = copyRelicState(readDataMember(source, 'state'));

  if (state !== undefined) {
    adopted.state = state;
  }

  return Object.freeze(adopted);
}

/**
 * Freezes one family record, its relic array and every relic in it.
 *
 * @param family Record to freeze.
 * @returns The same object, frozen.
 */
function freezeFamily(family: RelicFamily): RelicFamily {
  for (const relic of family.relics) {
    freezeRelic(relic);
  }

  Object.freeze(family.relics);

  return Object.freeze(family);
}

/**
 * Adopts an injected catalogue, keeping its order and dropping each entry that
 * does not carry a usable declaration shape.
 *
 * @param supplied Catalogue as the caller passed it.
 * @returns A fresh array of fresh frozen declarations.
 */
function adoptCatalogue(supplied: readonly Relic[]): Relic[] {
  const adopted: Relic[] = [];

  for (const entry of readEntries(supplied)) {
    if (isRelicShape(entry)) {
      adopted.push(adoptDefinition(entry));
    }
  }

  return adopted;
}

/**
 * Flattens family records into one relic sequence: families in the order given
 * and, within a family, in that family's declaration order.
 *
 * @param families Families to flatten.
 * @returns A fresh array.
 */
function flattenFamilies(families: readonly RelicFamily[]): Relic[] {
  const flattened: Relic[] = [];

  for (const family of families) {
    for (const relic of family.relics) {
      flattened.push(relic);
    }
  }

  return flattened;
}

/**
 * Indexes relics by identifier, keeping the FIRST declaration of a repeated
 * identifier so the index agrees with the catalogue sequence.
 *
 * @param relics Relics to index.
 * @returns A fresh map.
 */
function indexRelics(relics: readonly Relic[]): Map<string, Relic> {
  const index = new Map<string, Relic>();

  for (const relic of relics) {
    if (!index.has(relic.id)) {
      index.set(relic.id, relic);
    }
  }

  return index;
}

/**
 * Lists the identifiers a relic sequence repeats, once per repetition beyond
 * the first.
 *
 * @param relics Relics to scan.
 * @returns A fresh array; empty where every identifier is distinct.
 */
function repeatedIds(relics: readonly Relic[]): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];

  for (const relic of relics) {
    if (seen.has(relic.id)) {
      repeated.push(relic.id);
      continue;
    }

    seen.add(relic.id);
  }

  return repeated;
}

/**
 * The four relic families, in the `RELIC_FAMILY_NAMES` order `spawn-control`,
 * `merge-magic`, `board-manipulation`, `risk-reward-cursed`.
 *
 * Frozen at every level: the array, each family record, each family's relic
 * array, each relic and each relic's handler table.
 */
export const RELIC_FAMILIES: readonly RelicFamily[] = Object.freeze(
  orderFamilies(DECLARED_FAMILIES).map(freezeFamily),
);

/**
 * Every relic, flattened from `RELIC_FAMILIES`: families in ladder order and,
 * within a family, in that family's declaration order.
 */
export const RELIC_CATALOGUE: readonly Relic[] = Object.freeze(
  flattenFamilies(RELIC_FAMILIES),
);

/** `RELIC_CATALOGUE` indexed by identifier, built once at module scope. */
const CATALOGUE_BY_ID: ReadonlyMap<string, Relic> =
  indexRelics(RELIC_CATALOGUE);

/**
 * Reads one relic declaration from `RELIC_CATALOGUE` by identifier.
 *
 * @param id Identifier to look up.
 * @returns The declaration, or `undefined` where the catalogue carries none
 *   of that identifier.
 */
export function findRelicById(id: string): Relic | undefined {
  return CATALOGUE_BY_ID.get(id);
}

/**
 * ADDED: reinstates one relic's STANDING rule on a set of rehydrated rules.
 *
 * Handed the relic's persisted `state` slot and the live rules, and returns
 * whether it installed anything. It is not a hook handler: it receives no
 * dispatch context, no payload and no charge budget, and it cannot reach the
 * board.
 */
export type StandingRelicRule = (
  state: unknown,
  rules: RulesConfig,
) => boolean;

/**
 * ADDED: the relics whose effect is a STANDING rule on the live rules, mapped
 * to the function that reinstates it from a persisted slot.
 *
 * A standing rule is one that outlives the turn that established it and is
 * carried by the rules object rather than by the board — `frostbind`'s
 * frozen-cell merge predicate is the one such rule in the catalogue. A reload
 * builds fresh rules carrying the defaults, so without this the frost a spent
 * budget had already paid for was silently lost.
 *
 * Declared HERE and keyed by identifier, so the engine and the hook bus contain
 * no knowledge of any individual relic and the 7-member `Relic` shape AAP
 * Contract 3 fixes takes no eighth member. A family module owning a standing
 * rule exports its reinstatement function and is named in this table; every
 * other relic is absent from it and needs no entry. `DL-REGISTRY-04`.
 */
const STANDING_RELIC_RULES: ReadonlyMap<string, StandingRelicRule> = new Map<
  string,
  StandingRelicRule
>([['frostbind', reinstateFrostbindRule]]);

/**
 * ADDED: reinstates the standing rules a set of persisted relics implies, on
 * rules that were just rehydrated.
 *
 * THE NON-HOOK REHYDRATION PATH, and the counterpart of the charge guard: the
 * bus withholds all six hooks from a relic whose budget is spent (AAP R3, V6,
 * `DL-HOOKBUS-07`), so an exhausted relic reinstalls nothing of its own. What a
 * spent budget must not undo is the rule those charges ALREADY BOUGHT, and this
 * puts that rule back without dispatching to anything. Charges are therefore
 * not consulted at all: reinstatement is restoration, not firing.
 *
 * Order is the array's own order, which is pickup order on the load path, so a
 * later relic's rule wraps an earlier one exactly as a dispatch would have
 * layered them.
 *
 * @param relics Persisted entries, in pickup order. A nullish or non-array
 *   argument reinstates nothing.
 * @param rules Live rules to write into.
 * @returns How many standing rules were reinstated.
 */
export function applyStandingRelicRules(
  relics: readonly PersistedRelic[] | null | undefined,
  rules: RulesConfig,
): number {
  if (!isArrayValue(relics)) {
    return 0;
  }

  let applied = 0;

  for (const entry of readEntries(relics)) {
    const id: unknown = readPersisted(entry, 'id');

    if (typeof id !== 'string') {
      continue;
    }

    const reinstate = STANDING_RELIC_RULES.get(id);

    if (reinstate === undefined) {
      continue;
    }

    if (reinstate(readPersisted(entry, 'state'), rules)) {
      applied += 1;
    }
  }

  return applied;
}

/**
 * Reports whether `value` carries the two declaration members a registration
 * reads: a non-empty string `id` and an object `hooks`.
 *
 * @param value Value to test.
 * @returns `true` for a value usable as a declaration.
 */
function isRelicShape(value: unknown): value is Relic {
  if (!isRecord(value)) {
    return false;
  }

  const id: unknown = readDataMember(value, 'id');

  if (typeof id !== 'string' || id.length === 0) {
    return false;
  }

  return isRecord(readDataMember(value, 'hooks'));
}

/**
 * Reads one member of a persisted entry without trusting its declared type.
 *
 * @param entry Entry to read.
 * @param name Member to read.
 * @returns The stored value, or `undefined` where `entry` is not a plain
 *   object or carries no such member as data.
 */
function readPersisted(entry: unknown, name: string): unknown {
  return isRecord(entry) ? readDataMember(entry, name) : undefined;
}

/**
 * Reads the entries of a persisted relic array as data.
 *
 * @param source Array to read.
 * @returns A fresh array of at most `MAX_RESTORED_ENTRIES` entries.
 */
function readEntries(source: readonly unknown[]): unknown[] {
  const declared = readDataMember(source, 'length');
  const length = isFiniteNumber(declared) ? Math.trunc(declared) : 0;
  const bounded = Math.min(Math.max(0, length), MAX_RESTORED_ENTRIES);
  const entries: unknown[] = [];

  for (let index = 0; index < bounded; index += 1) {
    entries.push(readDataMember(source, String(index)));
  }

  return entries;
}

/**
 * Resolves the charge budget a freshly picked-up relic starts with.
 *
 * @param definition Declaration being picked up.
 * @returns The budget, or `undefined` for an unlimited relic.
 */
function seededCharges(definition: Relic): number | undefined {
  return definition.charges === undefined
    ? undefined
    : normaliseCharges(definition.charges);
}

/**
 * Resolves the charge budget a restored relic starts with.
 *
 * @param definition Declaration being restored.
 * @param entry Persisted entry.
 * @returns The budget, or `undefined` for an unlimited relic.
 */
function restoredCharges(
  definition: Relic,
  entry: unknown,
): number | undefined {
  if (definition.charges === undefined) {
    return undefined;
  }

  const recorded = readPersisted(entry, 'charges');

  if (recorded === undefined) {
    return normaliseCharges(definition.charges);
  }

  return isFiniteNumber(recorded) ? normaliseCharges(recorded) : 0;
}

/**
 * Resolves the state slot a restored relic starts with: a copy of the recorded
 * slot, or a copy of the declaration's initial slot where the entry carries
 * none.
 *
 * @param definition Declaration being restored.
 * @param entry Persisted entry.
 * @returns A fresh slot sharing no object with either input.
 */
function restoredState(definition: Relic, entry: unknown): unknown {
  const recorded = readPersisted(entry, 'state');

  return recorded === undefined
    ? copyRelicState(definition.state)
    : copyRelicState(recorded);
}

/**
 * Projects one held relic to the persisted triple of AAP Contract 5.
 *
 * @param relic Held relic to project.
 * @returns A fresh `{ id, charges?, state? }`.
 */
function persistRelic(relic: ActiveRelic): PersistedRelic {
  const entry: { id: string; charges?: number; state?: unknown } = {
    id: relic.definition.id,
  };

  if (relic.charges !== undefined) {
    entry.charges = normaliseCharges(relic.charges);
  }

  const state = copyRelicState(relic.state);

  if (state !== undefined) {
    entry.state = state;
  }

  return entry;
}

/**
 * Projects one held relic to its commit entry, writing `charges` only for a
 * relic carrying a budget.
 *
 * @param relic Held relic to project.
 * @returns A fresh frozen entry.
 */
function commitEntry(relic: ActiveRelic): RelicCommitEntry {
  const id = relic.definition.id;

  return Object.freeze(
    relic.charges === undefined
      ? { id }
      : { id, charges: normaliseCharges(relic.charges) },
  );
}

/**
 * Detaches one held record for a reader.
 *
 * @param relic Held record to detach.
 * @returns A fresh frozen record.
 */
function detachRelic(relic: ActiveRelic): ActiveRelic {
  return Object.freeze({
    definition: relic.definition,
    pickupOrder: relic.pickupOrder,
    charges: relic.charges,
    state: copyRelicState(relic.state),
  });
}

/**
 * Adopts the live budget and live slot the bus holds onto one held record.
 *
 * @param relic Record to refresh.
 * @param live The bus's snapshot of that relic, or `undefined` where the bus
 *   holds no registration under the identifier, in which case the record keeps
 *   the values it already carries.
 */
function adoptLive(
  relic: ActiveRelic,
  live: HookSubscriber | undefined,
): void {
  if (live === undefined) {
    return;
  }

  relic.charges = live.charges;
  relic.state = live.state;
}

/** The seven operations a run controller drives a registry through. */
export interface RelicRunPort {
  /** Projects the relics held, in pickup order, refreshed from the bus. */
  readonly snapshotRelics: () => readonly PersistedRelic[];

  /** Restores the relics a loaded envelope carried, in pickup order. */
  readonly restoreRelics: (relics: readonly PersistedRelic[]) => void;

  /**
   * Projects one HELD relic to the entry to persist.
   *
   * @returns The entry, and `null` for a relic that is not held.
   */
  readonly resolveRelic: (relicId: string) => PersistedRelic | null;

  /** Whether the catalogue carries the identifier. */
  readonly knowsRelic: (relicId: string) => boolean;

  /**
   * Takes one relic on for the rest of the run: appends it to pickup order,
   * seeds its budget and slot, and registers its handlers with the bus.
   *
   * @returns The entry to persist for the relic the registry accepted, and
   *   `null` for an identifier the catalogue does not carry, a relic already
   *   held, and a registration the bus refused.
   */
  readonly pickUpRelic: (relicId: string) => PersistedRelic | null;

  /**
   * The SAME activation step as `pickUpRelic`, under the second name
   * `RelicRegistryPort` of src/run/run-controller.ts accepts for it.
   *
   * @returns The entry to persist for the relic the registry accepted, and
   *   `null` for one it refused.
   */
  readonly activateRelic: (relicId: string) => PersistedRelic | null;

  /** Whether the registry holds the relic live, in pickup order. */
  readonly holdsRelic: (relicId: string) => boolean;
}

/** What `RelicRegistry.activate` reports. */
export interface RelicActivation extends ChargeConsumption {
  /** Identifier addressed, or `null` where the target named nothing held. */
  readonly relicId: string | null;

  /**
   * The bus's report, absent where nothing was asked of the bus — an unknown
   * target, an unusable amount, or a registry with no bus attached.
   */
  readonly consumption?: ChargeConsumption;
}

/**
 * How one registry is constructed. Every member is optional, so a unit test
 * constructs a registry with no argument and no mocking library, as
 * src/engine/engine.ts is constructed.
 */
export interface RelicRegistryOptions {
  /**
   * Relics `pickUp` and `restore` resolve an identifier against. Defaults to
   * `RELIC_CATALOGUE`, and a shorter pool may be injected in its place.
   */
  readonly catalogue?: readonly Relic[];

  /**
   * Bus every held relic is registered with. Absent on a registry that tracks
   * relics in its own records and registers none, which is the form that needs
   * no bus to be constructed at all.
   */
  readonly bus?: HookBus;

  /** Sink for counters. Defaults to `NOOP_ENGINE_REPORTER`. */
  readonly reporter?: EngineReporter;

  /**
   * Correlation identifier of the run, carried on every report. Injected,
   * never derived here: the one authority is `deriveCorrelationId` in
   * src/observability/logger.ts.
   */
  readonly correlationId?: CorrelationSource;

  /**
   * ADDED: the LIVE rules a restored relic's standing rule is reinstated into.
   *
   * Supplied by a composition that resumes a run, where the rules are rebuilt
   * from the defaults while the relics come back from the persisted envelope.
   * `restore()` reinstates every standing rule the restored entries imply
   * through `applyStandingRelicRules`, so the frost a spent budget already
   * bought survives the reload without any handler being dispatched.
   *
   * Absent on a registry that tracks relics alone, which reinstates nothing.
   * `DL-REGISTRY-04`.
   */
  readonly rules?: RulesConfig;
}

/** The relics one run holds, in pickup order. */
export class RelicRegistry {
  /** Relics an identifier is resolved against, frozen. */
  private readonly pool: readonly Relic[];

  /** `pool` indexed by identifier. */
  private readonly index: ReadonlyMap<string, Relic>;

  private readonly bus: HookBus | undefined;

  /**
   * ADDED: the live rules `restore()` reinstates standing rules into, or
   * `undefined` on a registry composed without them. `DL-REGISTRY-04`.
   */
  private readonly rules: RulesConfig | undefined;

  private readonly reporter: EngineReporter;

  /** Reads the run correlation identifier every report carries. */
  private readonly readCorrelationId: () => CorrelationId;

  /**
   * The correlation identifier every report from this registry carries, as it
   * stands now.
   */
  get correlationId(): CorrelationId {
    return this.readCorrelationId();
  }

  /** Held relics in pickup order, which is this array's own order. */
  private readonly held: ActiveRelic[] = [];

  /**
   * Pickup position the next relic takes. Advances only on a pickup that was
   * accepted and is never reassigned, so removing a relic renumbers nothing.
   */
  private nextPickupOrder = 0;

  /** Throws caught around the injected reporter. */
  private faults = 0;

  constructor(options: RelicRegistryOptions = {}) {
    const supplied = options.catalogue;

    // An injected catalogue is ADOPTED entry by entry: the caller's array and
    // the caller's objects are neither held nor modified, and what the
    // registry resolves against is frozen at every level.
    this.pool =
      supplied === undefined
        ? RELIC_CATALOGUE
        : Object.freeze(adoptCatalogue(supplied));
    this.index = indexRelics(this.pool);
    this.bus = options.bus;
    this.rules = options.rules;
    this.reporter = options.reporter ?? NOOP_ENGINE_REPORTER;
    this.readCorrelationId = correlationReader(options.correlationId);

    // A repeated catalogue identifier is REPORTED here, at construction, and
    // is never raised — neither here nor while this module is evaluated.
    const repeated = repeatedIds(this.pool);

    if (repeated.length > 0) {
      this.count(CATALOGUE_DUPLICATE_METRIC, repeated.length);
    }
  }

  /**
   * Delivers one counter, containing a throw from the reporter itself as
   * `deliver` in src/engine/hook-bus.ts contains one. Only the injected
   * reporter is guarded; no handler and no bus call is.
   *
   * @param metric Counter name.
   * @param value Amount to add; defaults to `1`.
   */
  private count(metric: string, value = 1): void {
    if (this.reporter.onCount === undefined) {
      return;
    }

    try {
      this.reporter.onCount({
        correlationId: this.readCorrelationId(),
        metric,
        value,
      });
    } catch {
      this.faults += 1;
    }
  }

  /**
   * Reads the number of throws caught around the injected reporter.
   *
   * @returns The count, which is `0` on a reporter that has never thrown.
   */
  reporterFaults(): number {
    return this.faults;
  }

  /**
   * Registers one relic with the bus, ONCE, carrying its whole handler table.
   *
   * @param relic Record to register.
   * @returns `true` when there is no bus, and otherwise whatever
   *   `HookBus.register` reported.
   */
  private attach(relic: ActiveRelic): boolean {
    const bus = this.bus;

    if (bus === undefined) {
      return true;
    }

    const subscriber: HookSubscriber = {
      id: relic.definition.id,
      hooks: relic.definition.hooks,
      pickupOrder: relic.pickupOrder,
      charges: relic.charges,
      state: relic.state,
    };

    return bus.register(subscriber);
  }

  /**
   * Refreshes every held record from the bus, which holds the live budget and
   * the live slot from registration onwards. A registry with no bus keeps its
   * own records, which are then the only values there are.
   */
  private refresh(): void {
    const bus = this.bus;

    if (bus === undefined || this.held.length === 0) {
      return;
    }

    const live = new Map<string, HookSubscriber>();

    for (const subscriber of bus.subscribers()) {
      live.set(subscriber.id, subscriber);
    }

    for (const relic of this.held) {
      adoptLive(relic, live.get(relic.definition.id));
    }
  }

  /**
   * Takes one relic on: appends it to pickup order, seeds its budget and slot,
   * and registers it.
   *
   * @param relic Declaration, or the identifier of one in this registry's
   *   catalogue.
   * @param entry Persisted entry the budget and slot are read from, or
   *   `undefined` to seed both from the declaration.
   * @returns The held record, or `undefined` where the relic was refused.
   */
  private take(
    relic: Relic | string,
    entry: unknown,
  ): ActiveRelic | undefined {
    const definition = this.resolve(relic);

    if (definition === undefined) {
      this.count(
        entry === undefined ? PICKUP_UNKNOWN_METRIC : RESTORE_UNKNOWN_METRIC,
      );

      return undefined;
    }

    if (this.has(definition.id)) {
      this.count(PICKUP_HELD_METRIC);

      return undefined;
    }

    return this.seat(definition, entry);
  }

  /**
   * Builds one held record, registers it and appends it to pickup order.
   *
   * @param definition Declaration to hold.
   * @param entry Persisted entry, or `undefined` for a fresh pickup.
   * @returns The held record, or `undefined` where the bus refused the
   *   registration, in which case nothing is appended and pickup order does
   *   not advance.
   */
  private seat(
    definition: Relic,
    entry: unknown,
  ): ActiveRelic | undefined {
    const held: ActiveRelic = {
      definition,
      pickupOrder: this.nextPickupOrder,
      charges:
        entry === undefined
          ? seededCharges(definition)
          : restoredCharges(definition, entry),
      state:
        entry === undefined
          ? copyRelicState(definition.state)
          : restoredState(definition, entry),
    };

    if (!this.attach(held)) {
      this.count(REGISTER_REFUSED_METRIC);

      return undefined;
    }

    this.held.push(held);
    this.nextPickupOrder += 1;
    this.count(entry === undefined ? PICKUP_METRIC : RESTORE_METRIC);

    return held;
  }

  /**
   * Resolves a declaration from an identifier or from a declaration.
   *
   * @param relic Declaration or identifier.
   * @returns The declaration, or `undefined` for an identifier the catalogue
   *   does not carry and for a value that is not a usable declaration.
   */
  private resolve(relic: Relic | string): Relic | undefined {
    if (typeof relic === 'string') {
      return this.index.get(relic);
    }

    if (!isRelicShape(relic)) {
      return undefined;
    }

    // An entry already in this registry's pool is the pool's own frozen object
    // and is used as it stands; anything else is a declaration from outside.
    const id = readDataMember(relic, 'id');
    const known = typeof id === 'string' ? this.index.get(id) : undefined;

    return known === relic ? known : adoptDefinition(relic);
  }

  /**
   * Takes one relic on for the rest of the run.
   *
   * Appends it to pickup order at the next position, seeds its budget from the
   * declaration's own budget and its slot from a COPY of the declaration's
   * initial slot, and registers it with the bus. One run's slot therefore
   * reaches no other run, no other registry and not the shared declaration.
   *
   * @param relicOrId A declaration, or the identifier of one in this
   *   registry's catalogue.
   * @returns A fresh frozen record detached from the registry's own, or
   *   `undefined` for an identifier the catalogue does not carry, a value that
   *   is not a usable declaration, a relic already held, and a registration
   *   the bus refused. Raises nothing.
   */
  pickUp(relicOrId: Relic | string): ActiveRelic | undefined {
    const held = this.take(relicOrId, undefined);

    return held === undefined ? undefined : detachRelic(held);
  }

  /**
   * Spends charges from a held relic's budget.
   *
   * TOTAL. Raises nothing. An identifier that is not held, a position past the
   * relics held, a position or amount that is not a whole number in range, and
   * a registry with no bus each spend nothing and report it.
   *
   * @param target Identifier of the relic to spend from, or its zero-based
   *   pickup position.
   * @param amount Charges to spend; defaults to `1`. A value that is not a
   *   positive whole number spends nothing.
   * @returns The bus's consumption report, flattened onto the result,
   *   together with the identifier addressed — `null` where nothing was held
   *   there — and the same report under `consumption`, absent where nothing
   *   was asked of the bus.
   */
  activate(target: string | number, amount = 1): RelicActivation {
    // Read from the refreshed held list, so an identifier resolves against the
    // budgets the bus holds and a position against the order the tray
    // rendered.
    this.refresh();

    const byPosition = typeof target !== 'string';

    if (byPosition && (!Number.isSafeInteger(target) || target < 0)) {
      this.count(ACTIVATE_REFUSED_METRIC);

      return REFUSED_ACTIVATION;
    }

    const held = byPosition
      ? this.held[target]
      : this.held.find((relic): boolean => relic.definition.id === target);

    if (held === undefined) {
      this.count(ACTIVATE_UNKNOWN_METRIC);

      return REFUSED_ACTIVATION;
    }

    const relicId = held.definition.id;
    const limited = held.charges !== undefined;
    const refused = Object.freeze({
      held: true,
      limited,
      consumed: 0,
      remaining: held.charges,
      relicId,
    });

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      this.count(ACTIVATE_REFUSED_METRIC);

      return refused;
    }

    const bus = this.bus;

    if (bus === undefined) {
      this.count(ACTIVATE_REFUSED_METRIC);

      return refused;
    }

    const consumption = bus.consumeCharge(relicId, amount);

    this.count(ACTIVATE_METRIC, 1);

    if (consumption.consumed <= 0) {
      this.count(ACTIVATE_EXHAUSTED_METRIC);
    }

    if (consumption.remaining !== undefined) {
      held.charges = consumption.remaining;
    }

    this.refresh();

    return Object.freeze({ ...consumption, relicId, consumption });
  }

  /**
   * Reads the held relics in pickup order, refreshed from the bus.
   *
   * Never sorted, grouped or rearranged by rarity, family or name: the order
   * is acquisition order. A consumer wanting another grouping derives it.
   *
   * @returns A fresh frozen array of fresh frozen records, each detached
   *   from the registry's own. A budget read here is the budget the bus holds
   *   as at this call, and writing to what is returned changes nothing held.
   */
  active(): readonly ActiveRelic[] {
    this.refresh();

    return Object.freeze(this.held.map(detachRelic));
  }

  /**
   * Reads one held relic by identifier, refreshed from the bus.
   *
   * @param id Identifier to look for.
   * @returns A fresh frozen record detached from the registry's own, or
   *   `undefined` where the relic is not held.
   */
  find(id: string): ActiveRelic | undefined {
    this.refresh();

    const held = this.held.find(
      (relic): boolean => relic.definition.id === id,
    );

    return held === undefined ? undefined : detachRelic(held);
  }

  /**
   * Reports whether one relic is held.
   *
   * @param id Identifier to look for.
   * @returns `true` when the relic is held.
   */
  has(id: string): boolean {
    return this.held.some((relic): boolean => relic.definition.id === id);
  }

  /**
   * Reports whether this registry's catalogue carries an identifier, whether
   * or not the relic is held.
   *
   * @param id Identifier to look for.
   * @returns `true` when the catalogue carries the identifier.
   */
  knows(id: string): boolean {
    return typeof id === 'string' && this.index.has(id);
  }

  /**
   * Reads the identifiers of the held relics in pickup order, which is the
   * `ownedIds` argument `drawRelicOffers` of src/relics/relic-draw.ts excludes
   * from an offer set.
   *
   * @returns A fresh frozen array.
   */
  ownedIds(): readonly string[] {
    return Object.freeze(
      this.held.map((relic): string => relic.definition.id),
    );
  }

  /**
   * Reads how many relics are held.
   *
   * @returns The count.
   */
  size(): number {
    return this.held.length;
  }

  /**
   * Reads the relics an identifier is resolved against: the injected catalogue
   * where one was injected, and `RELIC_CATALOGUE` otherwise. This is the
   * `pool` argument `drawRelicOffers` of src/relics/relic-draw.ts draws from.
   *
   * @returns The frozen catalogue; not a copy.
   */
  catalogue(): readonly Relic[] {
    return this.pool;
  }

  /**
   * Reads the identifiers of the held relics the bus has marked degraded, in
   * pickup order. A relic is marked when one of its handlers throws, and the
   * bus goes on skipping it for the rest of its registration.
   *
   * @returns A fresh frozen array; empty on a registry with no bus.
   */
  degradedIds(): readonly string[] {
    const bus = this.bus;

    if (bus === undefined) {
      return NO_IDS;
    }

    const marked = new Set<string>(bus.degraded());

    return Object.freeze(
      this.ownedIds().filter((id): boolean => marked.has(id)),
    );
  }

  /**
   * Drops every held relic and unregisters each one from the bus, leaving the
   * registry as a fresh run finds it with pickup order back at position zero.
   *
   * Every registration this registry made is removed, so a new run inherits no
   * subscription from the run before it.
   */
  clear(): void {
    const bus = this.bus;

    if (bus !== undefined) {
      for (const relic of this.held) {
        bus.unregister(relic.definition.id);
      }
    }

    const dropped = this.held.length;

    this.held.length = 0;
    this.nextPickupOrder = 0;

    if (dropped > 0) {
      this.count(CLEARED_METRIC, dropped);
    }
  }

  /**
   * Projects the held relics to the `relics` member of AAP Contract 5, in
   * pickup order: `Array<{ id, charges?, state? }>`.
   *
   * Corresponds to `serialize` at js/game_manager.js L102-L110. `charges` is
   * written only for a relic carrying a budget and `state` only where a slot
   * survives the copy, so the persisted payload carries no `undefined` member.
   * No storage is reached: src/run/run-state-store.ts writes what this
   * returns.
   *
   * @returns A fresh array of fresh plain objects, refreshed from the bus,
   *   so a budget spent during the turn just played is the budget persisted.
   */
  serialize(): PersistedRelic[] {
    this.refresh();

    const persisted: PersistedRelic[] = [];

    for (const relic of this.held) {
      persisted.push(persistRelic(relic));
    }

    return persisted;
  }

  /**
   * Projects ONE held relic to the persisted triple of AAP Contract 5.
   *
   * @param id Identifier of the relic to project.
   * @returns A fresh `{ id, charges?, state? }`, or `null` where the relic
   *   is not held. Raises nothing.
   */
  persistedEntry(id: string): PersistedRelic | null {
    this.refresh();

    const held = this.held.find(
      (relic): boolean => relic.definition.id === id,
    );

    return held === undefined ? null : persistRelic(held);
  }

  /**
   * Rebuilds the held relics from a persisted array, dropping whatever was
   * held first.
   *
   * Corresponds to the `if (previousState)` rehydration branch at
   * js/game_manager.js L36-L45. The array's own order becomes pickup order, so
   * a resumed run dispatches in the order the saved run dispatched in.
   *
   * ADDED: a registry composed with live rules also reinstates the STANDING
   * rules the restored entries imply, through `applyStandingRelicRules` and
   * without dispatching to any handler — so a relic whose budget the saved run
   * had already spent keeps the rule those charges bought while still being
   * withheld from every one of the six hooks. `DL-REGISTRY-04`.
   *
   * @param persisted Entries to restore.
   */
  restore(persisted: readonly PersistedRelic[] | null | undefined): void {
    this.clear();

    if (persisted === null || persisted === undefined) {
      return;
    }

    if (!isArrayValue(persisted)) {
      this.count(RESTORE_REJECTED_METRIC);

      return;
    }

    // `readEntries` reads `length` and each index as data and bounds the walk,
    // so neither the array's iterator nor a `Proxy` trap runs on this path.
    for (const entry of readEntries(persisted)) {
      this.reseat(entry);
    }

    this.reinstateStandingRules(persisted);
  }

  /**
   * ADDED: reinstates the standing rules the restored relics imply, reporting
   * how many landed.
   *
   * A registry composed without live rules reinstates nothing and reports
   * nothing. `DL-REGISTRY-04`.
   *
   * @param persisted Entries just restored, in pickup order.
   */
  private reinstateStandingRules(
    persisted: readonly PersistedRelic[],
  ): void {
    const rules = this.rules;

    if (rules === undefined) {
      return;
    }

    const applied = applyStandingRelicRules(persisted, rules);

    if (applied > 0) {
      this.count(STANDING_RULE_METRIC, applied);
    }
  }

  /**
   * Builds the port a run controller drives this registry through.
   *
   * @returns A frozen port bound to this registry.
   */
  runPort(): RelicRunPort {
    // The one implementation both activation names resolve to, so the two
    // spellings can never diverge in what they register or what they report.
    const takeOn = (relicId: string): PersistedRelic | null => {
      if (this.pickUp(relicId) === undefined) {
        return null;
      }

      return this.persistedEntry(relicId);
    };

    return Object.freeze({
      snapshotRelics: (): readonly PersistedRelic[] => this.serialize(),

      restoreRelics: (relics: readonly PersistedRelic[]): void => {
        this.restore(relics);
      },

      resolveRelic: (relicId: string): PersistedRelic | null =>
        this.persistedEntry(relicId),

      knowsRelic: (relicId: string): boolean => this.knows(relicId),

      pickUpRelic: takeOn,

      activateRelic: takeOn,

      holdsRelic: (relicId: string): boolean => this.has(relicId),
    });
  }

  /**
   * Restores one persisted entry, skipping and reporting one that cannot be
   * resolved.
   *
   * @param entry Entry to restore.
   */
  private reseat(entry: unknown): void {
    const id: unknown = readPersisted(entry, 'id');

    if (typeof id !== 'string' || id.length === 0) {
      this.count(RESTORE_MALFORMED_METRIC);

      return;
    }

    this.take(id, entry);
  }

  /**
   * Projects the held relics to the relic slice of a state commit, in pickup
   * order, refreshed from the bus.
   *
   * Satisfies `RelicCommitContext` of src/engine/types.ts, the port the engine
   * declares locally so that it never imports src/relics. `state` is not
   * carried: a commit's consumers show an identifier and a charge count.
   *
   * @returns A fresh frozen array, and `EMPTY_RELIC_CONTEXT` while no relic
   *   is held.
   */
  relicContext(): RelicCommitContext {
    this.refresh();

    if (this.held.length === 0) {
      return EMPTY_RELIC_CONTEXT;
    }

    return Object.freeze(this.held.map(commitEntry));
  }

  /**
   * Builds the provider the engine is handed to fill the `relics` member of
   * every `state:commit`.
   *
   * The provider reads through to this registry on each call and captures no
   * snapshot, so a relic picked up mid-run appears in the next commit.
   *
   * @returns A `RelicCommitContextProvider` bound to this registry.
   */
  commitContextProvider(): RelicCommitContextProvider {
    return (): RelicCommitContext => this.relicContext();
  }

  /**
   * `RelicRegistryPort.snapshotRelics`: the held relics in pickup order, with
   * the charges and state they hold as at this call.
   *
   * @returns A fresh array of fresh plain objects.
   */
  snapshotRelics(): readonly PersistedRelic[] {
    return this.serialize();
  }

  /**
   * `RelicRegistryPort.restoreRelics`: rebuilds the held relics from the
   * entries a loaded envelope carried, in the order it carried them.
   *
   * @param relics Entries to restore.
   */
  restoreRelics(relics: readonly PersistedRelic[]): void {
    this.restore(relics);
  }

  /**
   * `RelicRegistryPort.resolveRelic`: takes one drawn relic on and reports the
   * entry to persist for it.
   *
   * @param relicId Identifier the reward screen drew.
   * @returns The entry to persist, or `null` for an identifier this
   *   registry's catalogue does not carry and for a pickup the bus refused.
   */
  resolveRelic(relicId: string): PersistedRelic | null {
    const held = this.find(relicId);

    if (held !== undefined) {
      return persistRelic(held);
    }

    const taken = this.pickUp(relicId);

    if (taken === undefined) {
      return null;
    }

    return persistRelic(taken);
  }

  /**
   * `RelicRegistryPort.relicBoardSize`: the smallest edge length the persisted
   * relic entries imply, or `undefined` where they imply none.
   *
   * Called BEFORE the board is reconciled, on the entries
   * `RunStateStore.peekRelics` read straight out of storage, so the size a
   * cursed relic left the board at is applied to the lattice a resumed run is
   * built on.
   *
   * @param relics Persisted entries, exactly as they were stored.
   * @returns The implied edge length, or `undefined`.
   */
  relicBoardSize(
    relics: readonly PersistedRelic[],
  ): number | undefined {
    let smallest: number | undefined;

    for (const relic of relics) {
      const declared = readDeclaredBoardSize(relic);

      if (declared === undefined) {
        continue;
      }

      if (smallest === undefined || declared < smallest) {
        smallest = declared;
      }
    }

    return smallest;
  }
}

/**
 * The edge length one persisted entry declares through its own state slot.
 *
 * @param relic Entry to read.
 * @returns A positive safe integer, or `undefined` where the entry declares
 *   no usable edge length.
 */
function readDeclaredBoardSize(relic: PersistedRelic): number | undefined {
  const state: unknown = readPersisted(relic, 'state');

  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    return undefined;
  }

  const declared: unknown = (state as { boardSize?: unknown }).boardSize;

  if (typeof declared !== 'number' || !Number.isSafeInteger(declared)) {
    return undefined;
  }

  return declared > 0 ? declared : undefined;
}
