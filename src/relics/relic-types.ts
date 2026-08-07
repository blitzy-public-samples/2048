// The relic data vocabulary: the shape one relic is declared in, the two
// ladders it is classified by, and the two records it is held and
// persisted as.
//
// The leaf of src/relics/: every other module in the folder imports this
// one, and this one imports nothing from the folder. Type declarations,
// two frozen tuples and one frozen table only — no registry, no draw, no
// dispatch, and no relic declaration.
//
// AAP Contract 3 (0.6.1.3) is the `Relic` interface below, member for
// member. AAP Contract 5 (0.6.1.5) is `PersistedRelic`, the triple the
// run envelope's `relics` member carries.
//
// Provenance: nothing here is ported. js/game_manager.js, js/grid.js and
// js/tile.js declare no relic, no rarity and no family. What a relic
// binds to is ported — the six hooks of src/engine/hooks.ts, whose
// dispatch points are js/game_manager.js L7, L69-L76, L113-L120, L134,
// L156-L170, L183 and L185-L189, and js/grid.js L37-L43.
//
// Invariants of this module: it reads no DOM, performs no I/O, consumes
// no randomness, reads no clock and reports nothing. Importing it
// declares types and freezes two tuples and one table, and does nothing
// else.
//
// Decision log: docs/DECISION_LOG.md.

import type { HookHandlerTable } from '../engine/hooks';

/* --------------------------------------------------------------------------
 * 1. Rarity
 * ----------------------------------------------------------------------- */

/**
 * Every rarity tier, most common first.
 *
 * Frozen at runtime and a readonly tuple at compile time: the single
 * declaration of the four tiers, and the canonical iteration order over
 * them. `$rarity-tiers` of style/_tokens.scss L168 and `rarityTiers` of
 * src/theme/themes.ts carry the same four names in the same order.
 */
export const RARITIES = Object.freeze([
  'common',
  'uncommon',
  'rare',
  'legendary',
] as const);

/**
 * Rarity of one relic.
 *
 * Derived from `RARITIES`, so that tuple is the only place the four names
 * are written. A string union, so a rarity round-trips through JSON as
 * itself.
 */
export type Rarity = (typeof RARITIES)[number];

/**
 * The default draw weight of each tier, read by src/relics/relic-draw.ts.
 *
 * RELATIVE WEIGHTS, NOT PROBABILITIES. They are not required to sum to
 * one and are not to be rescaled so that they do: `pickWeighted` of
 * src/rng/rng-streams.ts divides by the total of the weights it is
 * given. Each tier's weight is half the tier before it.
 *
 * Frozen, so the shared table cannot be mutated through this reference.
 * A draw that weights the tiers differently passes a table of its own
 * and leaves this one as it stands.
 */
export const DEFAULT_RARITY_WEIGHTS: Readonly<Record<Rarity, number>> =
  Object.freeze({
    common: 8,
    uncommon: 4,
    rare: 2,
    legendary: 1,
  });

/* --------------------------------------------------------------------------
 * 2. Families
 * ----------------------------------------------------------------------- */

/**
 * Every relic family, in catalogue order.
 *
 * One name per module under src/relics/families/, and each name is that
 * module's file name: `spawn-control.ts`, `merge-magic.ts`,
 * `board-manipulation.ts` and `risk-reward-cursed.ts`. The comment at
 * style/_tokens.scss L163-L165 names the same four.
 */
export const RELIC_FAMILY_NAMES = Object.freeze([
  'spawn-control',
  'merge-magic',
  'board-manipulation',
  'risk-reward-cursed',
] as const);

/**
 * Name of one relic family.
 *
 * Derived from `RELIC_FAMILY_NAMES`, so that tuple is the only place the
 * four names are written.
 */
export type RelicFamilyName = (typeof RELIC_FAMILY_NAMES)[number];

/* --------------------------------------------------------------------------
 * 3. Handler table
 * ----------------------------------------------------------------------- */

/**
 * The handler table a relic binds, keyed by hook name.
 *
 * `HookHandlerTable` of src/engine/hooks.ts under this folder's name for
 * it: every key optional, and each key's handler narrowed to that hook's
 * own payload, so a handler bound to the wrong hook does not compile.
 * This is the `hooks` member of `Relic`.
 */
export type RelicHooks = HookHandlerTable;

/* --------------------------------------------------------------------------
 * 4. The relic declaration
 * ----------------------------------------------------------------------- */

/**
 * One relic, as its family module declares it: AAP Contract 3, these
 * seven members and no others.
 *
 * Plain data. Behaviour lives in the handlers of `hooks`; this interface
 * carries no effect function and no parameter bag. It carries no family
 * member either — the family of a relic is the `name` of the
 * `RelicFamily` that declares it.
 *
 * A declaration is a template shared by every run. `charges` and `state`
 * below are its initial values, and the live per-run values are the
 * `ActiveRelic` members of the same two names. `id` and `hooks` are the
 * declaration members src/engine/hook-bus.ts reads from a subscriber.
 */
export interface Relic {
  /** Stable identifier, unique across every family. */
  readonly id: string;

  /** Display name, as the reward card and the relic tray present it. */
  readonly name: string;

  /** Tier this relic is drawn at. */
  readonly rarity: Rarity;

  /** One-sentence description of the effect, as presented. */
  readonly description: string;

  /**
   * Handlers this relic binds. Every key is optional: a relic binds the
   * hooks it acts on and omits the rest.
   */
  readonly hooks: RelicHooks;

  /**
   * Charge budget a run starts this relic with. Absent on a relic that
   * fires for the rest of the run, which is never charge-guarded.
   */
  readonly charges?: number;

  /**
   * Initial value of the relic's own state slot. Absent on a relic that
   * carries none.
   *
   * JSON data only — no function, no closure, no class instance and no
   * cycle: the live value it initialises is persisted inside the
   * run-state envelope.
   */
  readonly state?: unknown;
}

/* --------------------------------------------------------------------------
 * 5. Family grouping
 * ----------------------------------------------------------------------- */

/**
 * One family's relics, as its module under src/relics/families/ exports
 * them.
 *
 * The family of a relic is this record's `name`, and not a member of
 * `Relic`. src/relics/relic-registry.ts assembles the catalogue from the
 * four families.
 */
export interface RelicFamily {
  /** Which family this is. */
  readonly name: RelicFamilyName;

  /** The relics the family declares, in declaration order. */
  readonly relics: readonly Relic[];
}

/* --------------------------------------------------------------------------
 * 6. Runtime and persisted records
 * ----------------------------------------------------------------------- */

/**
 * One relic a run holds, as src/relics/relic-registry.ts records it.
 *
 * Wraps a declaration: `definition` is the shared template, and
 * `charges` and `state` are this run's own values, taken from the
 * template at pickup. Writing either leaves the template as it stands.
 */
export interface ActiveRelic {
  /** The declaration this record holds, unmodified. */
  readonly definition: Relic;

  /**
   * Zero-based position in acquisition order.
   *
   * The order src/engine/hook-bus.ts dispatches handlers in, and the
   * order the relic tray renders the held relics in. Assigned at pickup
   * and never reassigned.
   */
  readonly pickupOrder: number;

  /**
   * Charges remaining, counting down from `definition.charges`.
   * `undefined` on a relic with no charge budget, which is never
   * charge-guarded; `0` on one whose budget is spent, whose handlers are
   * skipped.
   *
   * Written by src/relics/relic-registry.ts and by
   * src/engine/hook-bus.ts, which is where a charge is guarded and
   * decremented. A handler does neither.
   */
  charges: number | undefined;

  /**
   * The relic's own state slot for this run, initialised from
   * `definition.state`.
   *
   * The value `HookContext.state` of src/engine/hooks.ts carries to this
   * relic's handlers, and the value written back once a handler returns.
   * JSON data only, as `Relic.state` is.
   */
  state: unknown;
}

/**
 * One held relic as the run envelope persists it: AAP Contract 5's
 * triple, the shape the envelope's `relics` member carries.
 *
 * Narrower than a declaration — the wire carries no name, description,
 * rarity or handler table, and a relic is restored by looking `id` up in
 * the catalogue. JSON data only.
 */
export interface PersistedRelic {
  /** Identifier of the relic held, as its declaration carries it. */
  readonly id: string;

  /**
   * Charges remaining. Absent on a relic that carries no charge budget,
   * and `0` on one whose budget is exhausted.
   */
  readonly charges?: number;

  /** The relic's own persisted state. Absent when it holds none. */
  readonly state?: unknown;
}
