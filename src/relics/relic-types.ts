// The relic data vocabulary: the shape one relic is declared in, the two
// ladders it is classified by, and the two records it is held and persisted as.
//
// The leaf of src/relics/: every other module in the folder imports this one,
// and this one imports nothing from the folder. Type declarations, two frozen
// tuples and one frozen table only — no registry, no draw, no dispatch, and no
// relic declaration.
//
// This module reads no DOM, performs no I/O, consumes no randomness, reads no
// clock and reports nothing.
//
// target-only row of docs/TRACEABILITY_MATRIX.md, TR-RELIC-01 through
// TR-RELIC-05 in declaration order: the rarity ladder, the family ladder,
// Decisions behind this file: DL-RELIC-01, behaviour living in hook-bound
// handler functions, and DL-RELIC-02, the persisted relic being the

import type { HookHandlerTable } from '../engine/hooks';

/**
 * Every rarity tier, most common first.
 *
 * Frozen at runtime and a readonly tuple at compile time: the single
 * declaration of the four tiers, and the canonical iteration order over them.
 * `$rarity-tiers` in style/_tokens.scss and `rarityTiers` in
 * src/theme/themes.ts carry the same four names in the same order.
 */
export const RARITIES = Object.freeze([
  'common',
  'uncommon',
  'rare',
  'legendary',
] as const);

/**
 * Rarity of one relic, derived from `RARITIES`. A string union, so a rarity
 * round-trips through JSON as itself.
 */
export type Rarity = (typeof RARITIES)[number];

/**
 * The default draw weight of each tier.
 *
 * RELATIVE WEIGHTS, NOT PROBABILITIES. They are not required to sum to one and
 * are not to be rescaled so that they do: `pickWeighted` of
 * src/rng/rng-streams.ts divides by the total of the weights it is given. Each
 * tier's weight is half the tier before it.
 *
 * Frozen, so the shared table cannot be mutated through this reference. A draw
 * that weights the tiers differently passes a table of its own and leaves this
 * one as it stands.
 */
export const DEFAULT_RARITY_WEIGHTS: Readonly<Record<Rarity, number>> =
  Object.freeze({
    common: 8,
    uncommon: 4,
    rare: 2,
    legendary: 1,
  });

/**
 * Every relic family, in catalogue order. The comment above `$rarity-tiers` in
 * style/_tokens.scss names the same four.
 */
export const RELIC_FAMILY_NAMES = Object.freeze([
  'spawn-control',
  'merge-magic',
  'board-manipulation',
  'risk-reward-cursed',
] as const);

export type RelicFamilyName = (typeof RELIC_FAMILY_NAMES)[number];

/**
 * The handler table a relic binds, keyed by hook name: `HookHandlerTable` of
 * src/engine/hooks.ts under this folder's name for it. Every key is optional,
 * and each key's handler is narrowed to that hook's own payload, so a handler
 * bound to the wrong hook does not compile.
 */
export type RelicHooks = HookHandlerTable;

/**
 * One relic as a family module declares it: these SEVEN members and no others.
 *
 * Plain data. Behaviour lives in the handlers of `hooks`; this interface
 * carries no effect function and no parameter bag. It carries no family member
 * either — the family of a relic is the `name` of the `RelicFamily` that
 * declares it.
 *
 * A declaration is a template shared by every run. `charges` and `state` below
 * are its initial values, and the live per-run values are the `ActiveRelic`
 * members of the same two names. `id` and `hooks` are the declaration members
 * src/engine/hook-bus.ts reads from a subscriber.
 */
export interface Relic {
  readonly id: string;
  readonly name: string;
  readonly rarity: Rarity;
  readonly description: string;

  /**
   * Handlers this relic binds. Every key is optional: a relic binds the hooks
   * it acts on and omits the rest.
   */
  readonly hooks: RelicHooks;

  /**
   * Charge budget a run starts this relic with. Absent on a relic that fires
   * for the rest of the run, which is never charge-guarded.
   */
  readonly charges?: number;

  /**
   * Initial value of the relic's own state slot. Absent on a relic that
   * carries none.
   *
   * JSON data only — no function, no closure, no class instance and no cycle:
   * the live value it initialises is persisted inside the run-state envelope.
   */
  readonly state?: unknown;
}

/**
 * One family's relics, as its module under src/relics/families/ exports them.
 * The family of a relic is this record's `name`, and not a member of `Relic`.
 */
export interface RelicFamily {
  readonly name: RelicFamilyName;

  /** The relics the family declares, in declaration order. */
  readonly relics: readonly Relic[];
}

/**
 * One relic a run holds. Wraps a declaration: `definition` is the shared
 * template, and `charges` and `state` are this run's own values, taken from the
 * template at pickup. Writing either leaves the template as it stands.
 */
export interface ActiveRelic {
  readonly definition: Relic;

  /**
   * Zero-based position in acquisition order: the order
   * src/engine/hook-bus.ts dispatches handlers in. Assigned at pickup and
   * never reassigned.
   */
  readonly pickupOrder: number;

  /**
   * Charges remaining, counting down from `definition.charges`. `undefined` on
   * a relic with no charge budget, which is never charge-guarded; `0` on one
   * whose budget is spent, whose handlers are skipped.
   *
   * NOT DECREMENTED BY DISPATCH. src/engine/hook-bus.ts reads this member to
   * guard a handler, and deducts from it only through an explicit
   * `consumeCharge()` call; a dispatch that invokes a handler does not itself
   * spend a charge, and a handler does not write this member.
   */
  charges: number | undefined;

  /**
   * The relic's own state slot for this run, initialised from
   * `definition.state`. JSON data only, as `Relic.state` is.
   *
   * OWNED BY THE BUS, NOT SHARED WITH IT. src/engine/hook-bus.ts COPIES the
   * slot in full when the relic is registered, copies it again into
   * `HookContext.state` on every dispatch, and copies what the handler left
   * back onto its own record only once that handler has returned and its
   * return has been accepted. Three consequences follow, and each is why the
   * copying exists:
   *
   *   Writing this member after registration does not reach the value a
   *   dispatch reads. A run that has to change a live relic's state does it
   *   through the relic's own handler, which is the one path the bus commits.
   *
   *   Reading it back — here, or from a bus snapshot — never yields an object
   *   a handler still holds, so a stale reference cannot write into the run.
   *
   *   A handler that writes into a nested member and then throws changes
   *   nothing at all: the copy it wrote into is discarded with the rest of its
   *   transaction, including any randomness it drew.
   */
  state: unknown;
}

/**
 * One held relic as the run envelope persists it, and the shape the envelope's
 * `relics` member carries.
 *
 * Narrower than a declaration — the wire carries no name, description, rarity
 * or handler table, and a relic is restored by looking `id` up in the
 * catalogue. JSON data only.
 */
export interface PersistedRelic {
  readonly id: string;

  /**
   * Charges remaining. Absent on a relic that carries no charge budget, and
   * `0` on one whose budget is exhausted.
   */
  readonly charges?: number;
  readonly state?: unknown;
}
