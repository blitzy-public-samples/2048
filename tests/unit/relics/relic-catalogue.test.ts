// Static shape and composition gate over the assembled relic catalogue.
//
// UNIT UNDER TEST
//   src/relics/relic-types.ts     the `Relic` shape, the rarity ladder and the
//                                 family vocabulary
//   src/relics/relic-registry.ts  `RELIC_CATALOGUE`, `RELIC_FAMILIES` and
//                                 `findRelicById`
//   src/relics/families/*.ts      the four family records, read as data alone
//
// The four family modules are read here as declarations only: no handler is
// invoked, no hook is dispatched and no registry is constructed. Handler
// behaviour is covered by tests/unit/relics/relic-effects.test.ts and dispatch
// by the hook-bus suites under tests/unit/engine/.
//
// WHAT THIS FILE HOLDS
//   AAP Contract 3 fixes a relic declaration at seven members and places the
//   family outside the shape. An interface is erased before the catalogue is
//   assembled, so the seven-member set, the absent `family` member and the
//   charge-bearing set are asserted over the assembled data.
//
//   AAP Contract 2 fixes the six hook names and places both the charge guard
//   and the error isolation in src/engine/hook-bus.ts. The source-text scans of
//   section 5 hold the handler side of that division.
//
//   AAP Contract 6 routes every draw through a named substream reached from
//   `HookContext`, which is the `Math.random` scan of section 5.
//
// The identifier sequence pinned in section 1 is the sequence
// src/relics/relic-draw.ts resolves a drawn index against, and the recordings
// under tests/snapshot/__snapshots__/ are recorded against it.
//
// VANILLA ANCHORS
//   The rules these relics read from configuration rather than restate were
//   literals in the superseded manager: the start-tile count at
//   js/game_manager.js L7, the spawn distribution at L71, the merge predicate
//   at L156, the merge producer at L157 and the win value at L170, with the
//   spawn position at js/grid.js L37-L43. No expectation below restates one of
//   those numbers.
//
// AAP Figure 5, Hook Dispatch Sequence: Pickup-Order Fan-Out with Charge Guard
// and Error Isolation, carried by docs/architecture/hook-dispatch-sequence.md,
// depicts the dispatch whose preconditions sections 4 and 5 state.
//
// Traceability rows in docs/TRACEABILITY_MATRIX.md: TR-RELIC-01 through
// TR-RELIC-04 for the declaration vocabulary and TR-REGISTRY-04 for the
// assembled catalogue. Decisions in docs/DECISION_LOG.md: DL-RELIC-01,
// DL-RELIC-02, DL-REGISTRY-01 and DL-REGISTRY-02.
//
// This suite runs in the `unit:dom-free` project of vitest.config.ts under the
// `node` environment. It reaches for no document, no storage, no clock, no
// timer and no randomness, and it records no snapshot.

import { describe, expect, it } from 'vitest';

import { HOOK_NAMES, type HookName } from '../../../src/engine/hooks';
import {
  BOARD_MANIPULATION_FAMILY,
} from '../../../src/relics/families/board-manipulation';
import { MERGE_MAGIC_FAMILY } from '../../../src/relics/families/merge-magic';
import {
  RISK_REWARD_CURSED_FAMILY,
} from '../../../src/relics/families/risk-reward-cursed';
import {
  SPAWN_CONTROL_FAMILY,
} from '../../../src/relics/families/spawn-control';
import {
  RELIC_CATALOGUE,
  RELIC_FAMILIES,
  findRelicById,
} from '../../../src/relics/relic-registry';
import {
  DEFAULT_RARITY_WEIGHTS,
  RARITIES,
  RELIC_FAMILY_NAMES,
  type Rarity,
  type Relic,
  type RelicFamily,
  type RelicFamilyName,
} from '../../../src/relics/relic-types';

/* ==========================================================================
 * Expectations
 * ========================================================================== */

/** Families the catalogue publishes. */
const EXPECTED_FAMILY_COUNT = 4;

/** Relics each family declares. */
const EXPECTED_RELICS_PER_FAMILY = 4;

/** Relics the catalogue publishes in total. */
const EXPECTED_RELIC_COUNT = 16;

/** Hook names a relic may bind to. */
const EXPECTED_HOOK_COUNT = 6;

/** Members AAP Contract 3 fixes a relic declaration at. */
const EXPECTED_MEMBER_COUNT = 7;

/**
 * The seven members of AAP Contract 3, and the only members a relic declares.
 *
 * `family` is absent from the set: the family of a relic is the `name` of the
 * `RelicFamily` that declares it, held in `RELIC_FAMILIES`.
 */
const CONTRACT_MEMBERS: readonly string[] = [
  'id',
  'name',
  'rarity',
  'description',
  'hooks',
  'charges',
  'state',
];

/** The five of those seven that every declaration carries. */
const REQUIRED_MEMBERS: readonly string[] = [
  'id',
  'name',
  'rarity',
  'description',
  'hooks',
];

/**
 * Every relic identifier in catalogue order: the four families in
 * `RELIC_FAMILY_NAMES` order and, within a family, in that module's own
 * declaration order.
 *
 * Mirrors the `relics` arrays of `SPAWN_CONTROL_FAMILY`, `MERGE_MAGIC_FAMILY`,
 * `BOARD_MANIPULATION_FAMILY` and `RISK_REWARD_CURSED_FAMILY`.
 */
const DECLARED_ORDER: readonly string[] = [
  'twin-seed',
  'fertile-ground',
  'prospectors-eye',
  'loaded-dice',
  'echo-chamber',
  'alloy-forge',
  'frostbind',
  'chain-catalyst',
  'temporal-anchor',
  'tumbler',
  'culling-blade',
  'scouring-wind',
  'collapsing-vault',
  'gilded-rot',
  'brittle-crown',
  'hollow-ascension',
];

/** The four family records src/relics/relic-registry.ts flattens. */
const DECLARED_FAMILIES: readonly RelicFamily[] = [
  SPAWN_CONTROL_FAMILY,
  MERGE_MAGIC_FAMILY,
  BOARD_MANIPULATION_FAMILY,
  RISK_REWARD_CURSED_FAMILY,
];

/**
 * The relics that declare a charge budget, in catalogue order, and the only
 * relics that declare one. These five are the charge-exhaustion edge-case set
 * of AAP 0.1.2.5.
 */
const CHARGE_BEARING_IDS: readonly string[] = [
  'frostbind',
  'temporal-anchor',
  'tumbler',
  'culling-blade',
  'scouring-wind',
];

/** Hooks each named relic binds, as its family module declares them. */
const FIXED_BINDINGS: ReadonlyArray<readonly [string, readonly HookName[]]> = [
  ['temporal-anchor', ['onBeforeMove', 'onAfterMove']],
  ['collapsing-vault', ['onStageEnd']],
  ['brittle-crown', ['onStageStart', 'onStageEnd']],
  ['hollow-ascension', ['onMerge', 'onStageEnd']],
  ['gilded-rot', ['onMerge', 'onSpawn']],
  ['echo-chamber', ['onMerge']],
  ['alloy-forge', ['onMerge']],
  ['chain-catalyst', ['onMerge']],
];

/** The hook every relic of a family binds, whatever else it binds. */
const FAMILY_WIDE_BINDINGS: ReadonlyArray<
  readonly [RelicFamilyName, HookName]
> = [
  ['spawn-control', 'onSpawn'],
  ['merge-magic', 'onMerge'],
];

/** The families that declare a relic binding `onStageEnd`. */
const STAGE_END_FAMILIES: readonly RelicFamilyName[] = [
  'risk-reward-cursed',
  'board-manipulation',
];

/* ==========================================================================
 * Readers over the catalogue
 * ========================================================================== */

/**
 * Lists the hooks `relic` binds, in `HOOK_NAMES` order.
 *
 * @param relic Declaration to read.
 * @returns The bound hook names; empty where the relic binds none.
 */
function boundHooks(relic: Relic): HookName[] {
  return HOOK_NAMES.filter((hook) => relic.hooks[hook] !== undefined);
}

/**
 * Reads the source text of the handler `relic` binds to `hook`.
 *
 * @param relic Declaration to read.
 * @param hook Hook whose handler is wanted.
 * @returns The handler's source text, or an empty string where the relic binds
 *   no handler to that hook.
 */
function handlerSource(relic: Relic, hook: HookName): string {
  const handler = relic.hooks[hook];

  return handler === undefined ? '' : handler.toString();
}

/**
 * Lists every `<relic id>.<hook name>` whose bound handler's source text
 * carries `term`.
 *
 * @param term Text no handler carries.
 * @returns The offending bindings, named so a failure identifies the relic and
 *   the hook; empty where no handler carries the term.
 */
function handlerOffences(term: string): string[] {
  const offences: string[] = [];

  for (const relic of RELIC_CATALOGUE) {
    for (const hook of boundHooks(relic)) {
      if (handlerSource(relic, hook).includes(term)) {
        offences.push(`${relic.id}.${hook}`);
      }
    }
  }

  return offences;
}

/**
 * Reads one member of a declaration as an unknown value, so an optional member
 * can be tested for `null` as well as for absence.
 *
 * @param relic Declaration to read.
 * @param member Member name to read.
 * @returns The stored value, or `undefined` where the member is absent.
 */
function memberOf(relic: Relic, member: string): unknown {
  return (relic as unknown as Record<string, unknown>)[member];
}

/**
 * Reads the name of the family that declares `id`, from `RELIC_FAMILIES`
 * alone.
 *
 * @param id Relic identifier to place.
 * @returns The declaring family's name, or `undefined` where no family
 *   declares that identifier.
 */
function familyOf(id: string): RelicFamilyName | undefined {
  return RELIC_FAMILIES.find((family) =>
    family.relics.some((relic) => relic.id === id),
  )?.name;
}

/**
 * Reads the relics one family declares.
 *
 * @param name Family to read.
 * @returns That family's relics in declaration order; empty where the
 *   catalogue publishes no family of that name.
 */
function relicsOfFamily(name: RelicFamilyName): readonly Relic[] {
  return RELIC_FAMILIES.find((family) => family.name === name)?.relics ?? [];
}

/**
 * Reads the relics declared at one rarity tier.
 *
 * @param rarity Tier to read.
 * @returns Every relic of that tier, in catalogue order.
 */
function relicsOfRarity(rarity: Rarity): readonly Relic[] {
  return RELIC_CATALOGUE.filter((relic) => relic.rarity === rarity);
}

/**
 * Reads one relic declaration by identifier.
 *
 * @param id Identifier to read.
 * @returns The declaration.
 * @throws Error where the catalogue carries no relic of that identifier, which
 *   fails the test that asked for it and names the identifier.
 */
function relicById(id: string): Relic {
  const relic = findRelicById(id);

  if (relic === undefined) {
    throw new Error(`the catalogue carries no relic named ${id}`);
  }

  return relic;
}

/* ==========================================================================
 * 1. Catalogue composition
 * ========================================================================== */

describe('the relic catalogue composes the four declared families', () => {
  it('publishes exactly sixteen relic declarations', () => {
    expect(RELIC_CATALOGUE).toHaveLength(EXPECTED_RELIC_COUNT);
    expect(EXPECTED_FAMILY_COUNT * EXPECTED_RELICS_PER_FAMILY).toBe(
      EXPECTED_RELIC_COUNT,
    );
  });

  it(
    'publishes exactly four families, named spawn-control, merge-magic, ' +
      'board-manipulation and risk-reward-cursed in RELIC_FAMILY_NAMES order',
    () => {
      expect(RELIC_FAMILIES).toHaveLength(EXPECTED_FAMILY_COUNT);
      expect(RELIC_FAMILY_NAMES).toHaveLength(EXPECTED_FAMILY_COUNT);

      expect(RELIC_FAMILIES.map((family) => family.name)).toEqual([
        'spawn-control',
        'merge-magic',
        'board-manipulation',
        'risk-reward-cursed',
      ]);

      expect(RELIC_FAMILIES.map((family) => family.name)).toEqual([
        ...RELIC_FAMILY_NAMES,
      ]);
    },
  );

  it('gives each of the four families exactly four relics', () => {
    for (const family of RELIC_FAMILIES) {
      expect(family.relics).toHaveLength(EXPECTED_RELICS_PER_FAMILY);
    }
  });

  it(
    'is the four family modules flattened in family order, each module ' +
      'keeping its own declared relic order',
    () => {
      expect(RELIC_FAMILIES).toHaveLength(DECLARED_FAMILIES.length);

      DECLARED_FAMILIES.forEach((family, index) => {
        expect(RELIC_FAMILIES[index]).toBe(family);
      });

      const flattened = DECLARED_FAMILIES.flatMap((family) => [
        ...family.relics,
      ]);

      expect(RELIC_CATALOGUE).toHaveLength(flattened.length);

      flattened.forEach((relic, index) => {
        expect(RELIC_CATALOGUE[index]).toBe(relic);
      });
    },
  );

  it(
    'carries the sixteen identifiers as an exact ordered sequence, which the ' +
      'seeded reward draw resolves a drawn index against',
    () => {
      expect(DECLARED_ORDER).toHaveLength(EXPECTED_RELIC_COUNT);

      expect(RELIC_CATALOGUE.map((relic) => relic.id)).toEqual([
        ...DECLARED_ORDER,
      ]);
    },
  );

  it('gives every relic an identifier distinct from all fifteen others', () => {
    const ids = RELIC_CATALOGUE.map((relic) => relic.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids).size).toBe(EXPECTED_RELIC_COUNT);
  });

  it(
    'resolves every published identifier through findRelicById, and returns ' +
      'undefined without raising for an identifier it does not carry',
    () => {
      for (const relic of RELIC_CATALOGUE) {
        expect(findRelicById(relic.id)).toBe(relic);
      }

      expect(findRelicById('no-such-relic')).toBeUndefined();
      expect(findRelicById('')).toBeUndefined();
      expect(findRelicById('TWIN-SEED')).toBeUndefined();
    },
  );
});

/* ==========================================================================
 * 2. AAP Contract 3: the seven-member declaration shape
 * ========================================================================== */

describe('every relic declaration carries the Contract 3 member set', () => {
  it(
    'exposes only members drawn from id, name, rarity, description, hooks, ' +
      'charges and state, and never an eighth member',
    () => {
      expect(CONTRACT_MEMBERS).toHaveLength(EXPECTED_MEMBER_COUNT);

      const unexpected: string[] = [];

      for (const relic of RELIC_CATALOGUE) {
        for (const member of Object.keys(relic)) {
          if (!CONTRACT_MEMBERS.includes(member)) {
            unexpected.push(`${relic.id}.${member}`);
          }
        }
      }

      expect(unexpected).toEqual([]);
    },
  );

  it(
    'carries id, name, rarity, description and hooks on all sixteen relics',
    () => {
      for (const relic of RELIC_CATALOGUE) {
        const members = Object.keys(relic);

        for (const required of REQUIRED_MEMBERS) {
          expect(members).toContain(required);
        }
      }
    },
  );

  it(
    'carries id, name and description as non-empty strings on all sixteen ' +
      'relics',
    () => {
      for (const relic of RELIC_CATALOGUE) {
        expect(typeof relic.id).toBe('string');
        expect(typeof relic.name).toBe('string');
        expect(typeof relic.description).toBe('string');

        expect(relic.id.length).toBeGreaterThan(0);
        expect(relic.name.length).toBeGreaterThan(0);
        expect(relic.description.length).toBeGreaterThan(0);
      }
    },
  );

  it('carries a rarity drawn from RARITIES on all sixteen relics', () => {
    for (const relic of RELIC_CATALOGUE) {
      expect(RARITIES).toContain(relic.rarity);
    }
  });

  it(
    'carries hooks as a non-null plain object, never an array, on all ' +
      'sixteen relics',
    () => {
      for (const relic of RELIC_CATALOGUE) {
        expect(relic.hooks).not.toBeNull();
        expect(typeof relic.hooks).toBe('object');
        expect(Array.isArray(relic.hooks)).toBe(false);
      }
    },
  );

  it(
    'declares no family member on any of the sixteen relics, so the family ' +
      'of a relic is only the name of the RelicFamily that declares it',
    () => {
      for (const relic of RELIC_CATALOGUE) {
        expect('family' in relic).toBe(false);
        expect(Object.keys(relic)).not.toContain('family');

        expect(familyOf(relic.id)).not.toBeUndefined();
        expect(RELIC_FAMILY_NAMES).toContain(familyOf(relic.id));
      }
    },
  );

  it(
    'declares a charge budget on exactly frostbind, temporal-anchor, ' +
      'tumbler, culling-blade and scouring-wind',
    () => {
      const declared = RELIC_CATALOGUE.filter((relic) =>
        Object.hasOwn(relic, 'charges'),
      ).map((relic) => relic.id);

      expect(declared).toEqual([...CHARGE_BEARING_IDS]);
      expect(declared).toHaveLength(CHARGE_BEARING_IDS.length);
    },
  );

  it(
    'declares every charge budget as a finite number above zero, and leaves ' +
      'the member absent on the other eleven relics',
    () => {
      for (const relic of RELIC_CATALOGUE) {
        if (!CHARGE_BEARING_IDS.includes(relic.id)) {
          expect(Object.hasOwn(relic, 'charges')).toBe(false);
          expect(relic.charges).toBeUndefined();

          continue;
        }

        expect(typeof relic.charges).toBe('number');
        expect(Number.isFinite(relic.charges)).toBe(true);
        expect(relic.charges).toBeGreaterThan(0);
      }
    },
  );

  it(
    'declares neither charges nor state as null on any of the sixteen relics',
    () => {
      for (const relic of RELIC_CATALOGUE) {
        expect(memberOf(relic, 'charges')).not.toBeNull();
        expect(memberOf(relic, 'state')).not.toBeNull();
      }
    },
  );

  it(
    'declares state as a JSON value where it declares one, and leaves the ' +
      'member absent and undefined where it declares none',
    () => {
      for (const relic of RELIC_CATALOGUE) {
        if (!Object.hasOwn(relic, 'state')) {
          expect(relic.state).toBeUndefined();

          continue;
        }

        expect(memberOf(relic, 'state')).not.toBeUndefined();
        expect(() => JSON.stringify(relic.state)).not.toThrow();
      }
    },
  );
});

/* ==========================================================================
 * 3. The rarity ladder and the draw weights
 * ========================================================================== */

describe('the rarity ladder weights and populates every tier', () => {
  it(
    'keys DEFAULT_RARITY_WEIGHTS by exactly the RARITIES tiers and by no ' +
      'other, each at a positive finite weight',
    () => {
      const weighted = Object.keys(DEFAULT_RARITY_WEIGHTS);

      expect(weighted).toHaveLength(RARITIES.length);

      for (const rarity of RARITIES) {
        expect(weighted).toContain(rarity);

        const weight = DEFAULT_RARITY_WEIGHTS[rarity];

        expect(typeof weight).toBe('number');
        expect(Number.isFinite(weight)).toBe(true);
        expect(weight).toBeGreaterThan(0);
      }

      for (const key of weighted) {
        expect(RARITIES).toContain(key);
      }
    },
  );

  it(
    'gives every relic a rarity DEFAULT_RARITY_WEIGHTS carries a weight for, ' +
      'so a weighted draw can never miss a lookup',
    () => {
      for (const relic of RELIC_CATALOGUE) {
        expect(Object.hasOwn(DEFAULT_RARITY_WEIGHTS, relic.rarity)).toBe(true);
      }
    },
  );

  it(
    'uses every RARITIES tier at least once, and spreads the sixteen evenly ' +
      'at four relics to a tier',
    () => {
      expect(EXPECTED_RELIC_COUNT % RARITIES.length).toBe(0);

      const perTier = EXPECTED_RELIC_COUNT / RARITIES.length;

      for (const rarity of RARITIES) {
        const held = relicsOfRarity(rarity);

        expect(held.length).toBeGreaterThan(0);
        expect(held).toHaveLength(perTier);
      }
    },
  );
});

/* ==========================================================================
 * 4. AAP Contract 2: the six hook names a relic may bind
 * ========================================================================== */

describe('every relic binds handlers to the six named hooks alone', () => {
  it('binds at least one of the six hooks on all sixteen relics', () => {
    for (const relic of RELIC_CATALOGUE) {
      expect(boundHooks(relic).length).toBeGreaterThan(0);
    }
  });

  it(
    'binds no name outside the six of HOOK_NAMES, which are onStageStart, ' +
      'onBeforeMove, onMerge, onSpawn, onAfterMove and onStageEnd',
    () => {
      expect(HOOK_NAMES).toHaveLength(EXPECTED_HOOK_COUNT);

      expect([...HOOK_NAMES]).toEqual([
        'onStageStart',
        'onBeforeMove',
        'onMerge',
        'onSpawn',
        'onAfterMove',
        'onStageEnd',
      ]);

      const unexpected: string[] = [];

      for (const relic of RELIC_CATALOGUE) {
        for (const bound of Object.keys(relic.hooks)) {
          if (!HOOK_NAMES.includes(bound as HookName)) {
            unexpected.push(`${relic.id}.${bound}`);
          }
        }
      }

      expect(unexpected).toEqual([]);
    },
  );

  it('carries a function at every bound hook of all sixteen relics', () => {
    for (const relic of RELIC_CATALOGUE) {
      for (const hook of boundHooks(relic)) {
        expect(typeof relic.hooks[hook]).toBe('function');
      }
    }
  });

  it('covers all six hook names across the sixteen relics', () => {
    const covered = new Set<string>();

    for (const relic of RELIC_CATALOGUE) {
      for (const hook of boundHooks(relic)) {
        covered.add(hook);
      }
    }

    expect(covered.size).toBe(EXPECTED_HOOK_COUNT);

    for (const hook of HOOK_NAMES) {
      expect(covered).toContain(hook);
    }
  });

  it(
    'binds onSpawn on every spawn-control relic and onMerge on every ' +
      'merge-magic relic',
    () => {
      for (const [name, hook] of FAMILY_WIDE_BINDINGS) {
        const relics = relicsOfFamily(name);

        expect(relics).toHaveLength(EXPECTED_RELICS_PER_FAMILY);

        for (const relic of relics) {
          expect(boundHooks(relic)).toContain(hook);
        }
      }
    },
  );

  it(
    'binds onBeforeMove and onAfterMove on temporal-anchor, onStageEnd on ' +
      'collapsing-vault, onStageStart and onStageEnd on brittle-crown, ' +
      'onMerge and onStageEnd on hollow-ascension, onMerge and onSpawn on ' +
      'gilded-rot, and onMerge on echo-chamber, alloy-forge and ' +
      'chain-catalyst',
    () => {
      for (const [id, hooks] of FIXED_BINDINGS) {
        const bound = boundHooks(relicById(id));

        for (const hook of hooks) {
          expect(bound).toContain(hook);
        }
      }
    },
  );

  it(
    'binds onStageEnd only from relics the risk-reward-cursed or ' +
      'board-manipulation family declares',
    () => {
      const binders = RELIC_CATALOGUE.filter((relic) =>
        boundHooks(relic).includes('onStageEnd'),
      );

      expect(binders.length).toBeGreaterThan(0);

      for (const relic of binders) {
        expect(STAGE_END_FAMILIES).toContain(familyOf(relic.id));
      }
    },
  );
});

/* ==========================================================================
 * 5. No handler duplicates a responsibility src/engine/hook-bus.ts owns
 *
 * Each scan reads `Function.prototype.toString` over every bound handler. The
 * positive control that closes the section asserts the corpus is real, so a
 * scan cannot report an empty offence list over unreadable source text.
 * ========================================================================== */

describe('no relic handler duplicates a responsibility the bus owns', () => {
  it(
    'names charges in no handler of the sixteen relics, leaving the charge ' +
      'guard to src/engine/hook-bus.ts alone',
    () => {
      expect(handlerOffences('charges')).toEqual([]);
    },
  );

  it(
    'catches in no handler of the sixteen relics, so a throw reaches the ' +
      'error isolation of src/engine/hook-bus.ts and its injected reporter',
    () => {
      expect(handlerOffences('catch')).toEqual([]);
      expect(handlerOffences('try {')).toEqual([]);
    },
  );

  it(
    'names Math.random in no handler of the sixteen relics, so every draw ' +
      'flows through a named substream reached from HookContext',
    () => {
      expect(handlerOffences('Math.random')).toEqual([]);
    },
  );

  it(
    'names console in no handler of the sixteen relics, so reporting stays ' +
      'structured and injected',
    () => {
      expect(handlerOffences('console')).toEqual([]);
    },
  );

  it(
    'exposes readable source text at every bound handler of all sixteen ' +
      'relics, so the four scans above read a real corpus',
    () => {
      const scanned: string[] = [];
      const covered = new Set<string>();

      for (const relic of RELIC_CATALOGUE) {
        for (const hook of boundHooks(relic)) {
          const source = handlerSource(relic, hook);

          expect(source.length).toBeGreaterThan(0);
          expect(source).not.toContain('[native code]');

          scanned.push(`${relic.id}.${hook}`);
          covered.add(relic.id);
        }
      }

      expect(covered.size).toBe(EXPECTED_RELIC_COUNT);
      expect(scanned.length).toBeGreaterThanOrEqual(EXPECTED_RELIC_COUNT);
      expect(new Set(scanned).size).toBe(scanned.length);
    },
  );
});
