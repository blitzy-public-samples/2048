// The relic registry: the assembled catalogue, the pickup-ordered relics one
// run holds, and the conversion to and from the persisted triple.
//
// The front door of src/relics/. This module imports the four family modules
// and owns the flattened catalogue, and it is the only construct that knows a
// relic exists. Adding a relic is an edit to a family module and to nothing
// here.
//
// PROVENANCE
//   Generalises the three subscriptions installed at js/game_manager.js
//   L9-L11, where the manager bound one callback per input event once at
//   construction, into hook subscriptions taken on in pickup order during a
//   run. `serialize()` corresponds to js/game_manager.js L102-L110 and
//   `restore()` to the `if (previousState)` rehydration branch at L36-L45.
//   The `{ id, charges?, state? }` array the pair converts is the `relics`
//   member of AAP Contract 5. Where js/local_storage_manager.js L54 parsed a
//   stored value with no guard, `restore()` accepts every input — absent,
//   older, malformed or unknown — without raising.
//
// CHARGE AND STATE OWNERSHIP
//   This module SEEDS a run's charge budget and state slot, EXPOSES both,
//   REHYDRATES both, and SPENDS one on a player's behalf through `activate()`.
//   src/engine/hook-bus.ts skips a handler whose budget is spent and is the only
//   writer of a budget, through two paths that share one internal deduction: its
//   public `consumeCharge` and the dispatch walk's own spend, which a handler
//   asks for by calling `HookContext.spendCharge()`. A relic handler therefore
//   neither reads nor writes a count. The bus holds the live budget and the live
//   slot from registration onwards, so every read below refreshes this module's
//   records from `HookBus.subscribers()` before reporting them.
//
// THE RUN PORT
//   `runPort()` is the surface src/run/run-controller.ts drives a registry
//   through: the projection and restoration it already round-tripped, plus
//   catalogue membership, the LIVE pickup and the held test that a reward
//   selection is admitted by. It exists because `pickUp()` was reachable from
//   nowhere the controller could call: a chosen reward was appended to the
//   controller's own list, never registered with src/engine/hook-bus.ts, and
//   erased by the next commit's projection.
//
// ONE POOL AND ONE SLOT PER RELIC
//   A relic is registered ONCE, carrying its whole handler table:
//   `HookSubscriber` of src/engine/hook-bus.ts is per relic rather than per
//   hook. A relic binding two hooks therefore draws on one budget and reads
//   and writes one state slot across both bindings.
//
// PURITY
//   No DOM, no storage, no I/O, no clock and no randomness. Persistence
//   belongs to src/run/run-state-store.ts and the reward draw to
//   src/relics/relic-draw.ts, and this module reaches for neither: a caller
//   passes `catalogue()` or `RELIC_CATALOGUE` and `ownedIds()` into the draw
//   itself. Reporting goes to the injected `EngineReporter` alone.
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
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-REGISTRY-01  the registry as the only construct that names a relic; no
//                   engine, renderer or UI module branches on a relic id
//   DL-REGISTRY-02  one registration per relic carrying its whole handler
//                   table, one charge budget and one state slot
//   DL-REGISTRY-03  every read refreshing this module's records from
//                   `HookBus.subscribers()` before reporting them

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
import { HOOK_NAMES } from '../engine/hooks';
import { BOARD_MANIPULATION_FAMILY } from './families/board-manipulation';
import { MERGE_MAGIC_FAMILY } from './families/merge-magic';
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
  type CorrelationId,
  type EngineReporter,
  type RelicCommitContext,
  type RelicCommitContextProvider,
  type RelicCommitEntry,
} from '../engine/types';

/* --------------------------------------------------------------------------
 * Counter names
 * ----------------------------------------------------------------------- */

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

/** Counter raised for an activation that reached the bus. */
const ACTIVATE_METRIC = 'relics.activate';

/**
 * Counter raised for an activation naming nothing held: an identifier no held
 * relic carries, or a pickup position past the relics held.
 */
const ACTIVATE_UNKNOWN_METRIC = 'relics.activate.unknown';

/**
 * Counter raised for an activation the registry itself would not carry to the
 * bus: an amount that is not a positive whole number, a position that is not a
 * whole number at or above zero, and a registry with no bus attached.
 */
const ACTIVATE_REFUSED_METRIC = 'relics.activate.refused';

/**
 * Counter raised for an activation the bus took nothing for: a relic whose
 * budget is already spent, and a relic carrying no budget at all.
 */
const ACTIVATE_EXHAUSTED_METRIC = 'relics.activate.exhausted';

/* --------------------------------------------------------------------------
 * State copying
 * ----------------------------------------------------------------------- */

/**
 * Nesting depth a state slot is copied to, matching `MAX_STATE_DEPTH` of
 * src/engine/hook-bus.ts and `MAX_RELIC_STATE_DEPTH` of
 * src/run/run-state.ts. A branch deeper than this is dropped rather than
 * aliased, which is also what makes the copy terminate on a cycle.
 */
const MAX_STATE_DEPTH = 8;

/** Members one level of a state slot will carry. */
const MAX_STATE_MEMBERS = 256;

/**
 * Names a copied state slot never carries, matching `RESERVED_STATE_KEYS` of
 * src/run/run-state.ts. The value is mirrored rather than imported: src/run
 * imports `PersistedRelic` from src/relics, so an import in this direction
 * would close a cycle.
 *
 * `__proto__` is the load-bearing member. Written with `=`, an own property of
 * that name reaches `Object.prototype`'s setter and re-parents the copy instead
 * of becoming a member of it; `constructor` and `prototype` are refused
 * alongside it because a copy carrying either is no longer the plain data
 * object the run envelope describes.
 */
const RESERVED_STATE_KEYS: ReadonlySet<string> = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Entries `restore()` reads from one persisted array, matching
 * `MAX_PERSISTED_RELICS` of src/run/run-state.ts. Mirrored, not imported, for
 * the reason given above `RESERVED_STATE_KEYS`.
 */
const MAX_RESTORED_ENTRIES = 64;

/** The empty frozen array every identifier accessor falls back to. */
const NO_IDS: readonly string[] = Object.freeze([]);

/**
 * What `activate()` reports for a target no held relic answers to: nothing is
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
 * An accessor property is skipped rather than invoked, as
 * `cloneRelicStateMembers` of src/run/run-state.ts skips one, so a slot
 * carrying a getter is copied without that getter running. The descriptor read
 * itself is contained: a `Proxy` whose `getOwnPropertyDescriptor` trap raises
 * yields an unreadable member rather than a throw.
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
 * Contained for the same reason `readDataMember` is: a `Proxy` whose
 * `ownKeys` trap raises yields no member rather than a throw.
 *
 * @param source Object to enumerate.
 * @returns The own string-keyed names, and an empty list where they could not
 *   be read.
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
 * The destination carries NO PROTOTYPE and every member is written with
 * `Object.defineProperty`, and each name in `RESERVED_STATE_KEYS` is dropped
 * before either happens — the same three measures `cloneRelicStateMembers` of
 * src/run/run-state.ts takes, so a slot copied here and a slot copied by the
 * persisted loader carry the same members. Written by assignment onto `{}`, as
 * it was, a member named `__proto__` reached the prototype setter instead of
 * becoming data.
 *
 * @param source Level to copy.
 * @param depth Levels already descended.
 * @returns A fresh prototype-less object carrying the members that survive the
 *   copy.
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
 * TOTAL BY CONSTRUCTION. Every input yields a value and none raises: the depth
 * bound terminates the walk on a cycle, an accessor is read through
 * `readDataMember` rather than invoked, every reflection the walk performs is
 * contained so a `Proxy` trap that raises drops a member rather than the call,
 * and a value JSON cannot carry — a function, a symbol, a `bigint`,
 * `undefined` inside an object — is dropped exactly as `JSON.stringify` drops
 * it. A slot that survives a copy is a slot that survives the run envelope's
 * serialisation.
 *
 * The counterpart of `copyState` in src/engine/hook-bus.ts, which is that
 * module's own state-ownership boundary and is not exported.
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
 * Normalises one charge budget to a whole number within
 * `[0, Number.MAX_SAFE_INTEGER]`.
 *
 * Matches `normaliseCharges` of src/engine/hook-bus.ts, which is the rule the
 * bus reads a stored budget under, and clamps to a safe integer, which is the
 * form the non-negative-integer check in `checkRelics` of
 * src/run/run-state.ts accepts.
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

/* --------------------------------------------------------------------------
 * The catalogue
 * ----------------------------------------------------------------------- */

/**
 * The four family records as their modules export them, before ordering.
 *
 * `orderFamilies` below resolves the published order from
 * `RELIC_FAMILY_NAMES`, so this array's own order carries no meaning and no
 * order is ever read from object key enumeration.
 */
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
 * `RELIC_FAMILY_NAMES` of src/relics/relic-types.ts is the one declaration of
 * the family ladder, and it is the order read here; this file's import order
 * and `DECLARED_FAMILIES`'s own order are not. A family whose name the ladder
 * does not carry keeps its position behind the ordered ones, so no family is
 * dropped.
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
 * Only the six names `HOOK_NAMES` declares are carried, and each only where it
 * is stored as a callable, so a table carrying an accessor, a seventh member or
 * a non-callable value yields a table without it. Read through
 * `readDataMember`, so a `Proxy` table runs no trap here.
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
 * The caller's object is neither held nor modified. A fresh declaration is
 * built from the seven members `Relic` declares — read as data, so no accessor
 * and no proxy trap runs — with a fresh frozen handler table and a COPY of the
 * initial state slot, and the result is frozen. A caller that goes on to mutate
 * what it passed therefore changes nothing the registry holds, and no run's
 * slot reaches the caller's object.
 *
 * `RELIC_CATALOGUE` does not travel this path: `freezeFamily` has already
 * frozen every declaration in it and its handler table at module scope.
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
 * The four relic families, in the `RELIC_FAMILY_NAMES` order
 * `spawn-control`, `merge-magic`, `board-manipulation`,
 * `risk-reward-cursed`.
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
 *
 * THE SEQUENCE IS FIXED. src/relics/relic-draw.ts resolves a drawn index
 * against the pool it is handed in the order that pool carries, so this
 * sequence decides which relic a recorded seed offers and the snapshots under
 * tests/snapshot/__snapshots__/ are recorded against it. Frozen, and never
 * derived from object key enumeration.
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
 * @returns The declaration, or `undefined` where the catalogue carries none of
 *   that identifier. Raises nothing, so a stored identifier from an older
 *   version resolves to `undefined` rather than to a throw.
 */
export function findRelicById(id: string): Relic | undefined {
  return CATALOGUE_BY_ID.get(id);
}

/* --------------------------------------------------------------------------
 * Record conversion
 * ----------------------------------------------------------------------- */

/**
 * Reports whether `value` carries the two declaration members a registration
 * reads: a non-empty string `id` and an object `hooks`.
 *
 * Both members are read through `readDataMember`, so a declaration carrying
 * either as an accessor — or a `Proxy` standing in for one — is judged on
 * stored data alone and no foreign code runs during the test.
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
 * Read through `readDataMember`, so an entry carrying the member as an
 * accessor, or a `Proxy` whose `get` trap would run, yields `undefined` rather
 * than invoking anything.
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
 * `length` and each index are read through `readDataMember` and the walk is
 * bounded by `MAX_RESTORED_ENTRIES`, so a `Proxy` array cannot run a trap on
 * this path and cannot lengthen the walk without bound. An index carrying an
 * accessor yields `undefined`, which `reseat` reports as malformed.
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
 * A declaration carrying no budget yields `undefined`, which is the unlimited
 * form the bus never charge-guards and the form `PersistedRelic.charges` is
 * absent for. The unlimited form is `undefined` and never `Infinity` or `-1`.
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
 * THE DECLARATION DECIDES WHETHER A RELIC IS CHARGE-LIMITED AT ALL; the entry
 * decides only how many charges remain. A declaration carrying no budget
 * yields `undefined` whatever the entry says, so no stored value charge-limits
 * an unlimited relic or lifts the limit from a limited one.
 *
 * A recorded `0` is kept as `0`, so a relic whose budget was spent before the
 * run was saved stays spent and the bus's guard goes on skipping it. A recorded
 * value that is not a finite number is read as `0`, matching the bus's rule
 * that an invalid budget is spent rather than replenished. An absent value —
 * what an entry written by a version that recorded no budget carries — falls
 * back to the declaration's own budget.
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
 * `charges` is written only for a relic carrying a budget and `state` only
 * where a slot survives the copy, so no `undefined` member reaches the run
 * envelope. The object is plain and unfrozen, as `cloneRelic` of
 * src/run/run-state.ts produces.
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
 * `ActiveRelic` declares `charges` and `state` as writable, so handing back the
 * record itself would let a reader write the registry's own budget and slot and
 * would alias the slot the bus holds. The copy is frozen and carries a COPY of
 * the slot, so a reader can neither write through it nor reach the bus's data;
 * `definition` is a frozen declaration and is shared rather than copied.
 *
 * Taken AFTER `refresh()`, so the values carried are the values the bus
 * holds as at the call that produced them.
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

/* --------------------------------------------------------------------------
 * The run port
 * ----------------------------------------------------------------------- */

/**
 * The six operations a run controller drives a registry through.
 *
 * DECLARED HERE, NOT IMPORTED. `RelicRegistryPort` of
 * src/run/run-controller.ts declares the same six members, so this record
 * satisfies that port structurally and neither folder imports the other. Every
 * member is total: none raises, whatever it is given.
 *
 * `pickUpRelic` is the LIVE registration step. A reward that is not taken on
 * through it never reaches src/engine/hook-bus.ts, so its handlers never fire
 * and the projection this port reports does not carry it — which is how a
 * controller-only append was erased by the next commit.
 */
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

  /** Whether the registry holds the relic live, in pickup order. */
  readonly holdsRelic: (relicId: string) => boolean;
}

/* --------------------------------------------------------------------------
 * The registry
 * ----------------------------------------------------------------------- */

/**
 * How one registry is constructed. Every member is optional, so a unit test
 * constructs a registry with no argument and no mocking library, as
 * src/engine/engine.ts is constructed.
 */
/**
 * What `RelicRegistry.activate()` reports.
 *
 * The bus's `ChargeConsumption` FLATTENED onto the result — `held`, `limited`,
 * `consumed` and `remaining` are read directly — plus the identifier the target
 * resolved to and the same report under `consumption`. Both shapes are carried
 * because both are needed: a caller holding an identifier reads the consumption
 * it asked for, and a caller holding a pickup position must first learn which
 * relic that position named.
 */
export interface RelicActivation extends ChargeConsumption {
  /** Identifier addressed, or `null` where the target named nothing held. */
  readonly relicId: string | null;

  /**
   * The bus's report, absent where nothing was asked of the bus — an unknown
   * target, an unusable amount, or a registry with no bus attached.
   */
  readonly consumption?: ChargeConsumption;
}

export interface RelicRegistryOptions {
  /**
   * Relics `pickUp` and `restore` resolve an identifier against. Defaults to
   * `RELIC_CATALOGUE`, and a shorter pool may be injected in its place. A
   * supplied array is copied and frozen, so the caller's array is neither held
   * nor modified.
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
   * src/observability/logger.ts. Defaults to the empty string.
   */
  readonly correlationId?: CorrelationId;
}

/**
 * The relics one run holds, in pickup order.
 *
 * Generalises the three fixed subscriptions of js/game_manager.js L9-L11 into
 * a set that grows as a run collects relics. Pickup order is assigned here and
 * is the order src/engine/hook-bus.ts dispatches in, so it decides both how
 * effects compound and the order handlers consume randomness in; the HUD reads
 * the same order for its tray.
 *
 * NOTHING HERE BRANCHES ON AN INDIVIDUAL RELIC. Every method treats a relic
 * through `Relic`, `ActiveRelic` and `PersistedRelic` alone.
 */
export class RelicRegistry {
  /** Relics an identifier is resolved against, frozen. */
  private readonly pool: readonly Relic[];

  /** `pool` indexed by identifier. */
  private readonly index: ReadonlyMap<string, Relic>;

  private readonly bus: HookBus | undefined;

  private readonly reporter: EngineReporter;

  private readonly correlationId: CorrelationId;

  /** Held relics in pickup order, which is this array's own order. */
  private readonly held: ActiveRelic[] = [];

  /**
   * Pickup position the next relic takes. Advances only on a pickup that was
   * accepted and is never reassigned, so removing a relic renumbers nothing.
   * Reset by `clear()`, which starts a new run at position zero.
   */
  private nextPickupOrder = 0;

  /** Throws caught around the injected reporter. */
  private faults = 0;

  constructor(options: RelicRegistryOptions = {}) {
    const supplied = options.catalogue;

    // An injected catalogue is ADOPTED entry by entry: the caller's array and
    // the caller's objects are neither held nor modified, and what the registry
    // resolves against is frozen at every level. `RELIC_CATALOGUE` is used as
    // it stands, `freezeFamily` having already frozen it at module scope.
    this.pool =
      supplied === undefined
        ? RELIC_CATALOGUE
        : Object.freeze(adoptCatalogue(supplied));
    this.index = indexRelics(this.pool);
    this.bus = options.bus;
    this.reporter = options.reporter ?? NOOP_ENGINE_REPORTER;
    this.correlationId = options.correlationId ?? '';

    // A repeated catalogue identifier is REPORTED here, at construction, and
    // is never raised — neither here nor while this module is evaluated.
    const repeated = repeatedIds(this.pool);

    if (repeated.length > 0) {
      this.count(CATALOGUE_DUPLICATE_METRIC, repeated.length);
    }
  }

  /* ------------------------------------------------------------------------
   * Reporting
   * --------------------------------------------------------------------- */

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
        correlationId: this.correlationId,
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

  /* ------------------------------------------------------------------------
   * Bus attachment
   * --------------------------------------------------------------------- */

  /**
   * Registers one relic with the bus, ONCE, carrying its whole handler table.
   * The bus binds only the hooks the table binds to a callable handler, so a
   * relic acting on one hook creates one binding rather than six, and the
   * budget and the slot the registration carries are shared by every binding
   * it creates.
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
   * An identifier is looked up in this registry's catalogue. A declaration is
   * taken on its own terms once it carries a usable shape and need not appear
   * in that catalogue; it is ADOPTED rather than held, so the caller's object
   * is neither retained nor modified and what this registry holds is frozen.
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
    // The identifier is read as data, so a `Proxy` declaration runs no trap.
    const id = readDataMember(relic, 'id');
    const known = typeof id === 'string' ? this.index.get(id) : undefined;

    return known === relic ? known : adoptDefinition(relic);
  }

  /* ------------------------------------------------------------------------
   * Pickup
   * --------------------------------------------------------------------- */

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
   *   is not a usable declaration, a relic already held, and a registration the
   *   bus refused. Raises nothing.
   */
  pickUp(relicOrId: Relic | string): ActiveRelic | undefined {
    const held = this.take(relicOrId, undefined);

    return held === undefined ? undefined : detachRelic(held);
  }

  /* ------------------------------------------------------------------------
   * Activation
   * --------------------------------------------------------------------- */

  /**
   * Spends charges from a held relic's budget.
   *
   * THE ONE PATH A BUDGET IS SPENT ON FROM OUTSIDE A DISPATCH. src/engine/hook-bus.ts
   * writes a budget in exactly two places — the spend a handler asks for through
   * `HookContext.spendCharge`, and `consumeCharge`, which this method calls — so a
   * manual activation and a handler's own request draw on ONE shared pool. The
   * bus's own report is handed straight back, so a caller sees whether the relic
   * was held, whether it is charge-limited, how many charges were actually taken,
   * and how many remain, which is what makes exhaustion observable rather than
   * silent.
   *
   * ADDRESSED BY IDENTIFIER OR BY PICKUP POSITION. A string names the relic
   * directly, which is what a run controller and the relic API hold. A number is
   * a zero-based PICKUP POSITION, which is what a player's `activateRelic` press
   * carries: the HUD's relic tray is rendered in pickup order — the same order
   * the bus dispatches in — so the index resolves against `active()` directly and
   * a player activating "the second relic" spends from the relic they can see in
   * the second slot.
   *
   * TOTAL. Raises nothing. An identifier that is not held, a position past the
   * relics held, a position or amount that is not a whole number in range, and a
   * registry with no bus each spend nothing and report it.
   *
   * @param target Identifier of the relic to spend from, or its zero-based
   *   pickup position.
   * @param amount Charges to spend; defaults to `1`. A value that is not a
   *   positive whole number spends nothing.
   * @returns The bus's consumption report, flattened onto the result, together
   *   with the identifier addressed — `null` where nothing was held there — and
   *   the same report under `consumption`, absent where nothing was asked of the
   *   bus.
   */
  activate(target: string | number, amount = 1): RelicActivation {
    // Read from the refreshed held list, so an identifier resolves against the
    // budgets the bus holds and a position against the order the tray rendered.
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

    // The bus is the authority on the budget, so what it left is copied back onto
    // this registry's own record at once rather than at the next refresh, and the
    // refresh below carries it onto every projection `serialize()` persists.
    if (consumption.remaining !== undefined) {
      held.charges = consumption.remaining;
    }

    this.refresh();

    return Object.freeze({ ...consumption, relicId, consumption });
  }

  /* ------------------------------------------------------------------------
   * Queries
   * --------------------------------------------------------------------- */

  /**
   * Reads the held relics IN PICKUP ORDER, refreshed from the bus.
   *
   * Never sorted, grouped or rearranged by rarity, family or name: the order
   * is acquisition order. A consumer wanting another grouping derives it.
   *
   * @returns A fresh frozen array of fresh frozen records, each detached from
   *   the registry's own. A budget read here is the budget the bus holds as at
   *   this call, and writing to what is returned changes nothing held.
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
   * Reports whether this registry's catalogue carries an identifier, whether or
   * not the relic is held.
   *
   * The check a reward selection is validated with: an identifier no catalogue
   * carries is an identifier no offer could have drawn, and is refused before a
   * pickup is attempted.
   *
   * @param id Identifier to look for.
   * @returns `true` when the catalogue carries the identifier.
   */
  knows(id: string): boolean {
    return typeof id === 'string' && this.index.has(id);
  }

  /**
   * Reads the identifiers of the held relics IN PICKUP ORDER, which is the
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
   * where one was injected, and `RELIC_CATALOGUE` otherwise. This is the `pool`
   * argument `drawRelicOffers` of src/relics/relic-draw.ts draws from.
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

  /* ------------------------------------------------------------------------
   * Run lifecycle
   * --------------------------------------------------------------------- */

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

  /* ------------------------------------------------------------------------
   * Persistence conversion
   * --------------------------------------------------------------------- */

  /**
   * Projects the held relics to the `relics` member of AAP Contract 5, IN
   * PICKUP ORDER: `Array<{ id, charges?, state? }>`.
   *
   * Corresponds to `serialize()` at js/game_manager.js L102-L110. `charges` is
   * written only for a relic carrying a budget and `state` only where a slot
   * survives the copy, so the persisted payload carries no `undefined` member.
   * No storage is reached: src/run/run-state-store.ts writes what this returns.
   *
   * @returns A fresh array of fresh plain objects, refreshed from the bus, so
   *   a budget spent during the turn just played is the budget persisted.
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
   * The single-relic counterpart of `serialize()`, and what a caller persisting
   * a freshly picked-up relic reads: the budget and slot are refreshed from the
   * bus first, so the entry carries the values the bus holds rather than the
   * values the declaration seeded.
   *
   * @param id Identifier of the relic to project.
   * @returns A fresh `{ id, charges?, state? }`, or `null` where the relic is
   *   not held. Raises nothing.
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
   * TOTAL. Every input is accepted and none raises, which is the guard
   * js/local_storage_manager.js L54 lacked: `null`, `undefined`, a value that
   * is not an array and an empty array each leave no relic held; an entry with
   * no identifier, with an identifier that is not a non-empty string, with an
   * identifier the catalogue does not carry, or repeating an identifier already
   * restored is skipped and reported, and the entries around it still load.
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
  }

  /**
   * Builds the port a run controller drives this registry through.
   *
   * THE ONE ROUTE BETWEEN THE TWO FOLDERS. `RelicRegistryPort` of
   * src/run/run-controller.ts names the same six members, so the object
   * returned here satisfies that port without either folder importing the
   * other. Each member is bound to this instance and reads through to it on
   * every call, so a relic taken on after the port was built is a relic the
   * port reports.
   *
   * `pickUpRelic` is what makes a chosen reward LIVE: it registers the relic's
   * handlers with the bus and returns the entry to persist for exactly the
   * relic the registry accepted, so the controller can append that entry rather
   * than one of its own.
   *
   * @returns A frozen port bound to this registry.
   */
  runPort(): RelicRunPort {
    return Object.freeze({
      snapshotRelics: (): readonly PersistedRelic[] => this.serialize(),

      restoreRelics: (relics: readonly PersistedRelic[]): void => {
        this.restore(relics);
      },

      resolveRelic: (relicId: string): PersistedRelic | null =>
        this.persistedEntry(relicId),

      knowsRelic: (relicId: string): boolean => this.knows(relicId),

      pickUpRelic: (relicId: string): PersistedRelic | null => {
        if (this.pickUp(relicId) === undefined) {
          return null;
        }

        return this.persistedEntry(relicId);
      },

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

  /* ------------------------------------------------------------------------
   * Commit context
   * --------------------------------------------------------------------- */

  /**
   * Projects the held relics to the relic slice of a state commit, IN PICKUP
   * ORDER, refreshed from the bus.
   *
   * Satisfies `RelicCommitContext` of src/engine/types.ts, the port the engine
   * declares locally so that it never imports src/relics. `state` is not
   * carried: a commit's consumers show an identifier and a charge count.
   *
   * @returns A fresh frozen array, and `EMPTY_RELIC_CONTEXT` while no relic is
   *   held.
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

  /* ------------------------------------------------------------------------
   * The run controller's port
   * --------------------------------------------------------------------- */

  // src/run/run-controller.ts declares `RelicRegistryPort` structurally rather
  // than importing this class, so that src/run compiles and is exercised
  // without src/relics. The three members below are that port, and a
  // `RelicRegistry` therefore satisfies it as it stands: the controller
  // round-trips the held relics through them on every load, every write and
  // every reward it resolves.

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
   * The pickup happens HERE, which is what registers the relic's handlers with
   * the bus: the controller resolves a reward by identifier and the registry
   * turns that identifier into a live, dispatching subscriber. A relic already
   * held is reported at the charges and state it already carries rather than
   * being reseated, so resolving the same identifier twice cannot reset it.
   *
   * @param relicId Identifier the reward screen drew.
   * @returns The entry to persist, or `null` for an identifier this registry's
   *   catalogue does not carry and for a pickup the bus refused.
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
   * GENERIC, AND NAMES NO RELIC. Any relic whose persisted `state` carries a
   * numeric `boardSize` is declaring the edge length its effect leaves the
   * board at; the smallest such declaration wins, because a board that two
   * relics have shrunk stands at the smaller of the two. AAP Contract 3 forbids
   * special-casing an individual relic, so this reads the declaration rather
   * than the identifier — a second board-mutating relic needs no change here.
   *
   * Called BEFORE the board is reconciled, on the entries
   * `RunStateStore.peekRelics()` read straight out of storage, so the size a
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
 * @returns A positive safe integer, or `undefined` where the entry declares no
 *   usable edge length.
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
