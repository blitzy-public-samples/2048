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
//   This module SEEDS a run's charge budget and state slot, EXPOSES both and
//   REHYDRATES both. src/engine/hook-bus.ts skips a handler whose budget is
//   spent and is the only writer of a budget, through `consumeCharge`. A relic
//   handler does neither. The bus holds the live budget and the live slot from
//   registration onwards, so every read below refreshes this module's records
//   from `HookBus.subscribers()` before reporting them.
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
// Decisions behind this file are recorded in docs/DECISION_LOG.md, and its
// rows in docs/TRACEABILITY_MATRIX.md.

import {
  RELIC_FAMILY_NAMES,
  type ActiveRelic,
  type PersistedRelic,
  type Relic,
  type RelicFamily,
  type RelicFamilyName,
} from './relic-types';
import { BOARD_MANIPULATION_FAMILY } from './families/board-manipulation';
import { MERGE_MAGIC_FAMILY } from './families/merge-magic';
import { RISK_REWARD_CURSED_FAMILY } from './families/risk-reward-cursed';
import { SPAWN_CONTROL_FAMILY } from './families/spawn-control';
import type { HookBus, HookSubscriber } from '../engine/hook-bus';
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

/** The empty frozen array every identifier accessor falls back to. */
const NO_IDS: readonly string[] = Object.freeze([]);

/**
 * Reports whether `value` is a plain object: an object that is neither `null`
 * nor an array.
 *
 * @param value Value to test.
 * @returns `true` for a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
 * Reads one data member of a state slot.
 *
 * An accessor property is skipped rather than invoked, as
 * `cloneRelicStateMembers` of src/run/run-state.ts skips one, so a slot
 * carrying a getter is copied without that getter running.
 *
 * @param source Object to read.
 * @param name Own property to read.
 * @returns The stored value, or `undefined` for an absent property and for an
 *   accessor.
 */
function readDataMember(source: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, name);

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
  const length = Math.min(entries.length, MAX_STATE_MEMBERS);

  for (let index = 0; index < length; index += 1) {
    copied.push(copyRelicState(entries[index], depth + 1) ?? null);
  }

  return copied;
}

/**
 * Copies the members of one object level of a state slot.
 *
 * @param source Level to copy.
 * @param depth Levels already descended.
 * @returns A fresh object carrying the members that survive the copy.
 */
function copyStateMembers(
  source: object,
  depth: number,
): Record<string, unknown> {
  const copied: Record<string, unknown> = {};
  let kept = 0;

  for (const name of Object.getOwnPropertyNames(source)) {
    if (kept >= MAX_STATE_MEMBERS) {
      break;
    }

    const member = copyRelicState(readDataMember(source, name), depth + 1);

    if (member !== undefined) {
      copied[name] = member;
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
 * `readDataMember` rather than invoked, and a value JSON cannot carry — a
 * function, a symbol, a `bigint`, `undefined` inside an object — is dropped
 * exactly as `JSON.stringify` drops it. A slot that survives a copy is a slot
 * that survives the run envelope's serialisation.
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

  if (Array.isArray(value)) {
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
 * @param value Value to test.
 * @returns `true` for a value usable as a declaration.
 */
function isRelicShape(value: unknown): value is Relic {
  if (!isRecord(value)) {
    return false;
  }

  const id: unknown = value['id'];

  return typeof id === 'string' && id.length > 0 && isRecord(value['hooks']);
}

/**
 * Reads one member of a persisted entry without trusting its declared type.
 *
 * @param entry Entry to read.
 * @param name Member to read.
 * @returns The stored value, or `undefined` where `entry` is not a plain
 *   object or carries no such member.
 */
function readPersisted(entry: unknown, name: string): unknown {
  return isRecord(entry) ? entry[name] : undefined;
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
  entry: PersistedRelic,
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
function restoredState(definition: Relic, entry: PersistedRelic): unknown {
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
 * The registry
 * ----------------------------------------------------------------------- */

/**
 * How one registry is constructed. Every member is optional, so a unit test
 * constructs a registry with no argument and no mocking library, as
 * src/engine/engine.ts is constructed.
 */
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

    this.pool =
      supplied === undefined
        ? RELIC_CATALOGUE
        : Object.freeze(supplied.slice());
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
    entry: PersistedRelic | undefined,
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
    entry: PersistedRelic | undefined,
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
   * in that catalogue.
   *
   * @param relic Declaration or identifier.
   * @returns The declaration, or `undefined` for an identifier the catalogue
   *   does not carry and for a value that is not a usable declaration.
   */
  private resolve(relic: Relic | string): Relic | undefined {
    if (typeof relic === 'string') {
      return this.index.get(relic);
    }

    return isRelicShape(relic) ? relic : undefined;
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
   * @returns The held record, or `undefined` for an identifier the catalogue
   *   does not carry, a value that is not a usable declaration, a relic
   *   already held, and a registration the bus refused. Raises nothing.
   */
  pickUp(relicOrId: Relic | string): ActiveRelic | undefined {
    return this.take(relicOrId, undefined);
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
   * @returns A fresh frozen array whose elements are the live records, so a
   *   budget read here is the budget the bus holds as at this call.
   */
  active(): readonly ActiveRelic[] {
    this.refresh();

    return Object.freeze(this.held.slice());
  }

  /**
   * Reads one held relic by identifier, refreshed from the bus.
   *
   * @param id Identifier to look for.
   * @returns The held record, or `undefined` where the relic is not held.
   */
  find(id: string): ActiveRelic | undefined {
    this.refresh();

    return this.held.find(
      (relic): boolean => relic.definition.id === id,
    );
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

    if (!Array.isArray(persisted)) {
      this.count(RESTORE_REJECTED_METRIC);

      return;
    }

    for (const entry of persisted) {
      this.reseat(entry);
    }
  }

  /**
   * Restores one persisted entry, skipping and reporting one that cannot be
   * resolved.
   *
   * @param entry Entry to restore.
   */
  private reseat(entry: PersistedRelic): void {
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
}
