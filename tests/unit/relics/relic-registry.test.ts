// The relic registry: the catalogue, pickup order, charge accounting, the
// manual activation path and the persistence projection.
//
// TWO SUITES IN ONE FILE, because two review units each wrote one and both sets
// of expectations are kept. Each builds its own registry, so neither observes the
// other's held relics.

import { describe, expect, it } from 'vitest';

import type { HookBus } from '../../../src/engine/hook-bus';
import { createHookBus } from '../../../src/engine/hook-bus';
import { HOOK_NAMES, type HookName } from '../../../src/engine/hooks';
import {
  RELIC_CATALOGUE,
  RELIC_FAMILIES,
  RelicRegistry,
  findRelicById,
  type RelicRunPort,
} from '../../../src/relics/relic-registry';
import type { RelicRegistryPort } from '../../../src/run/run-controller';
import {
  RARITIES,
  RELIC_FAMILY_NAMES,
  type PersistedRelic,
  type Relic,
} from '../../../src/relics/relic-types';

/* ===== Constants the catalogue is measured against ===== */

const EXPECTED_FAMILY_COUNT = 4;

const EXPECTED_RELICS_PER_FAMILY = 4;

const EXPECTED_RELIC_COUNT = EXPECTED_FAMILY_COUNT * EXPECTED_RELICS_PER_FAMILY;

/** The seven members `Relic` declares, and the only members a relic carries. */
const DECLARED_MEMBERS: readonly string[] = [
  'id',
  'name',
  'rarity',
  'description',
  'hooks',
  'charges',
  'state',
];

/* ===== The catalogue ===== */

describe('relic catalogue', () => {
  it('publishes the four declared families, in catalogue order', () => {
    expect(RELIC_FAMILIES.map((family) => family.name)).toEqual([
      ...RELIC_FAMILY_NAMES,
    ]);
  });

  it('holds sixteen relics, four to a family', () => {
    expect(RELIC_CATALOGUE).toHaveLength(EXPECTED_RELIC_COUNT);

    for (const family of RELIC_FAMILIES) {
      expect(family.relics).toHaveLength(EXPECTED_RELICS_PER_FAMILY);
    }
  });

  it('gives every relic a distinct identifier', () => {
    const ids = RELIC_CATALOGUE.map((relic) => relic.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives each family one relic per rarity tier', () => {
    for (const family of RELIC_FAMILIES) {
      expect(family.relics.map((relic) => relic.rarity)).toEqual([...RARITIES]);
    }
  });

  it('spreads the sixteen evenly across the four tiers', () => {
    for (const rarity of RARITIES) {
      expect(
        RELIC_CATALOGUE.filter((relic) => relic.rarity === rarity),
      ).toHaveLength(EXPECTED_FAMILY_COUNT);
    }
  });

  it('gives every relic a name and a description', () => {
    for (const relic of RELIC_CATALOGUE) {
      expect(relic.name.length).toBeGreaterThan(0);
      expect(relic.description.length).toBeGreaterThan(0);
    }
  });

  it('carries EXACTLY the seven members Relic declares, and no eighth', () => {
    for (const relic of RELIC_CATALOGUE) {
      for (const member of Object.keys(relic)) {
        expect(DECLARED_MEMBERS).toContain(member);
      }
    }
  });

  it('binds every handler to one of the six named hooks', () => {
    for (const relic of RELIC_CATALOGUE) {
      const bound = Object.keys(relic.hooks) as HookName[];

      expect(bound.length).toBeGreaterThan(0);

      for (const hook of bound) {
        expect(HOOK_NAMES).toContain(hook);
        expect(typeof relic.hooks[hook]).toBe('function');
      }
    }
  });

  it('covers all six hooks across the catalogue', () => {
    const covered = new Set<string>();

    for (const relic of RELIC_CATALOGUE) {
      for (const hook of Object.keys(relic.hooks)) {
        covered.add(hook);
      }
    }

    for (const hook of HOOK_NAMES) {
      expect(covered).toContain(hook);
    }
  });

  it('declares a charge budget above zero wherever it declares one', () => {
    for (const relic of RELIC_CATALOGUE) {
      if (relic.charges !== undefined) {
        expect(Number.isSafeInteger(relic.charges)).toBe(true);
        expect(relic.charges).toBeGreaterThan(0);
      }
    }
  });

  it('declares only JSON-serialisable initial state', () => {
    for (const relic of RELIC_CATALOGUE) {
      if (relic.state !== undefined) {
        expect(() => JSON.stringify(relic.state)).not.toThrow();
      }
    }
  });

  it('resolves every identifier it publishes, and nothing else', () => {
    for (const relic of RELIC_CATALOGUE) {
      expect(findRelicById(relic.id)).toBe(relic);
    }

    expect(findRelicById('no-such-relic')).toBeUndefined();
    expect(findRelicById('')).toBeUndefined();
  });

  it('is frozen, so a consumer cannot rewrite the draw pool', () => {
    expect(Object.isFrozen(RELIC_CATALOGUE)).toBe(true);
    expect(Object.isFrozen(RELIC_FAMILIES)).toBe(true);
  });
});

/* ===== Pickup ===== */

describe('RelicRegistry pickup', () => {
  it('is constructible with no argument at all', () => {
    const registry = new RelicRegistry();

    expect(registry.size()).toBe(0);
    expect(registry.catalogue()).toBe(RELIC_CATALOGUE);
  });

  it('takes a relic on by identifier and by declaration alike', () => {
    const registry = new RelicRegistry();
    const first = RELIC_CATALOGUE[0] as Relic;
    const second = RELIC_CATALOGUE[1] as Relic;

    expect(registry.pickUp(first.id)?.definition).toBe(first);
    expect(registry.pickUp(second)?.definition).toBe(second);
    expect(registry.size()).toBe(2);
  });

  it('assigns pickup order in acquisition order', () => {
    const registry = new RelicRegistry();

    for (const relic of RELIC_CATALOGUE.slice(0, 4)) {
      registry.pickUp(relic);
    }

    expect(registry.active().map((entry) => entry.pickupOrder)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(registry.ownedIds()).toEqual(
      RELIC_CATALOGUE.slice(0, 4).map((relic) => relic.id),
    );
  });

  it('refuses an identifier the catalogue does not carry', () => {
    const registry = new RelicRegistry();

    expect(registry.pickUp('no-such-relic')).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it('refuses a relic already held, and keeps the one it has', () => {
    const registry = new RelicRegistry();
    const relic = RELIC_CATALOGUE[0] as Relic;
    const taken = registry.pickUp(relic);

    expect(registry.pickUp(relic)).toBeUndefined();
    expect(registry.size()).toBe(1);
    // `find` hands back a DETACHED frozen record over a copied state slot, so
    // the entry is compared by value: what matters is that the registry still
    // holds the relic it took first, unchanged by the refusal.
    expect(registry.find(relic.id)).toStrictEqual(taken);
  });

  it('resolves an identifier only against the pool it was given', () => {
    const pool = RELIC_CATALOGUE.slice(0, 2);
    const registry = new RelicRegistry({ catalogue: pool });
    const outside = RELIC_CATALOGUE[5] as Relic;

    expect(registry.pickUp(outside.id)).toBeUndefined();
    expect(registry.pickUp(pool[0] as Relic)).toBeDefined();
  });

  it('copies the pool it is given, so the caller cannot grow it later', () => {
    const pool = RELIC_CATALOGUE.slice(0, 2);
    const registry = new RelicRegistry({ catalogue: pool });

    expect(registry.catalogue()).toHaveLength(2);
    expect(registry.catalogue()).not.toBe(pool);
  });

  it('takes charges and state from the declaration at pickup', () => {
    const registry = new RelicRegistry();
    const charged = RELIC_CATALOGUE.find(
      (relic) => relic.charges !== undefined,
    ) as Relic;
    const taken = registry.pickUp(charged);

    expect(taken?.charges).toBe(charged.charges);
    expect(taken?.state).toEqual(charged.state);
  });

  it('reports what it holds without exposing its own array', () => {
    const registry = new RelicRegistry();

    registry.pickUp(RELIC_CATALOGUE[0] as Relic);

    expect(registry.has((RELIC_CATALOGUE[0] as Relic).id)).toBe(true);
    expect(registry.has('no-such-relic')).toBe(false);
    expect(registry.active()).not.toBe(registry.active());
  });

  it('clears every relic and restarts pickup order at zero', () => {
    const registry = new RelicRegistry();

    registry.pickUp(RELIC_CATALOGUE[0] as Relic);
    registry.pickUp(RELIC_CATALOGUE[1] as Relic);
    registry.clear();

    expect(registry.size()).toBe(0);

    expect(registry.pickUp(RELIC_CATALOGUE[2] as Relic)?.pickupOrder).toBe(0);
  });
});

/* ===== Bus registration ===== */

describe('RelicRegistry bus registration', () => {
  it('registers a picked-up relic with the bus, in pickup order', () => {
    const bus = createHookBus();
    const registry = new RelicRegistry({ bus });
    const taken = RELIC_CATALOGUE.slice(0, 3);

    for (const relic of taken) {
      registry.pickUp(relic);
    }

    expect(bus.subscribers().map((entry) => entry.id)).toEqual(
      taken.map((relic) => relic.id),
    );
  });

  it('unregisters every relic it registered when it is cleared', () => {
    const bus = createHookBus();
    const registry = new RelicRegistry({ bus });

    registry.pickUp(RELIC_CATALOGUE[0] as Relic);
    registry.clear();

    expect(bus.subscribers()).toHaveLength(0);
  });

  it('reads a correlation READER on every counter it reports', () => {
    const carried: string[] = [];
    let current = 'run-first';
    const registry = new RelicRegistry({
      bus: createHookBus(),
      catalogue: [adHoc(), adHoc()],
      correlationId: (): string => current,
      reporter: {
        onCount: (entry): void => {
          carried.push(entry.correlationId);
        },
      },
    });

    // The duplicate identifier of the injected catalogue is counted at
    // construction, under the run in force then.
    expect(carried).toEqual(['run-first']);

    // A second run of one page load: a registry that captured the identifier
    // kept reporting under the run that ended.
    current = 'run-second';
    registry.pickUp('no-such-relic');

    expect(carried[carried.length - 1]).toBe('run-second');
  });

  it('needs no bus to be constructed or to track relics', () => {
    const registry = new RelicRegistry();

    expect(registry.pickUp(RELIC_CATALOGUE[0] as Relic)).toBeDefined();
    expect(registry.size()).toBe(1);
  });

  it('exposes a commit-context provider that reads through to the registry', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });
    const provider = registry.commitContextProvider();

    expect(provider()).toHaveLength(0);

    registry.pickUp(RELIC_CATALOGUE[0] as Relic);

    expect(provider().map((entry) => entry.id)).toEqual([
      (RELIC_CATALOGUE[0] as Relic).id,
    ]);
  });

  it('carries a spent budget into the commit context', () => {
    const bus = createHookBus();
    const registry = new RelicRegistry({ bus });
    const charged = RELIC_CATALOGUE.find(
      (relic) => relic.charges !== undefined,
    ) as Relic;

    registry.pickUp(charged);
    bus.consumeCharge(charged.id, 1);

    const entry = registry
      .relicContext()
      .find((row) => row.id === charged.id);

    expect(entry?.charges).toBe((charged.charges ?? 0) - 1);
  });
});

/* ===== Persistence ===== */

describe('RelicRegistry persistence', () => {
  it('serialises the held relics in pickup order', () => {
    const registry = new RelicRegistry();
    const taken = RELIC_CATALOGUE.slice(0, 3);

    for (const relic of taken) {
      registry.pickUp(relic);
    }

    expect(registry.serialize().map((entry) => entry.id)).toEqual(
      taken.map((relic) => relic.id),
    );
  });

  it('writes charges only for a relic that carries a budget', () => {
    const registry = new RelicRegistry();

    for (const relic of RELIC_CATALOGUE) {
      registry.pickUp(relic);
    }

    for (const entry of registry.serialize()) {
      const declared = findRelicById(entry.id);

      if (declared?.charges === undefined) {
        expect('charges' in entry).toBe(false);
      } else {
        expect(entry.charges).toBe(declared.charges);
      }
    }
  });

  it('round-trips order, charges and state through a restore', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });
    const taken = RELIC_CATALOGUE.slice(2, 6);

    for (const relic of taken) {
      registry.pickUp(relic);
    }

    const persisted = registry.serialize();
    const resumed = new RelicRegistry({ bus: createHookBus() });

    resumed.restore(persisted);

    expect(resumed.serialize()).toEqual(persisted);
    expect(resumed.active().map((entry) => entry.pickupOrder)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('serialises to fresh plain objects a caller cannot write through', () => {
    const registry = new RelicRegistry();

    registry.pickUp(RELIC_CATALOGUE[0] as Relic);

    expect(registry.serialize()).not.toBe(registry.serialize());
    expect(registry.serialize()).toEqual(registry.serialize());
  });

  it('accepts every input to restore without raising', () => {
    const registry = new RelicRegistry();
    const rejected: readonly unknown[] = [
      null,
      undefined,
      'not an array',
      42,
      {},
      [],
      [null],
      [{}],
      [{ id: '' }],
      [{ id: 42 }],
      [{ id: 'no-such-relic' }],
    ];

    for (const input of rejected) {
      expect(() =>
        registry.restore(input as readonly PersistedRelic[] | null),
      ).not.toThrow();
    }

    expect(registry.size()).toBe(0);
  });

  it('loads the entries around one it cannot resolve', () => {
    const registry = new RelicRegistry();
    const first = RELIC_CATALOGUE[0] as Relic;
    const second = RELIC_CATALOGUE[1] as Relic;

    registry.restore([
      { id: first.id },
      { id: 'no-such-relic' },
      { id: second.id },
    ]);

    expect(registry.ownedIds()).toEqual([first.id, second.id]);
  });

  it('keeps the first of a repeated identifier', () => {
    const registry = new RelicRegistry();
    const charged = RELIC_CATALOGUE.find(
      (relic) => relic.charges !== undefined,
    ) as Relic;

    registry.restore([
      { id: charged.id, charges: 2 },
      { id: charged.id, charges: 1 },
    ]);

    expect(registry.size()).toBe(1);
    expect(registry.find(charged.id)?.charges).toBe(2);
  });

  it('carries no charge budget for a relic whose declaration carries none', () => {
    const registry = new RelicRegistry();
    const unlimited = RELIC_CATALOGUE.find(
      (relic) => relic.charges === undefined,
    ) as Relic;

    registry.restore([{ id: unlimited.id, charges: 5 }]);

    expect(registry.find(unlimited.id)?.charges).toBeUndefined();
  });

  it('drops whatever was held before a restore', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });

    registry.pickUp(RELIC_CATALOGUE[0] as Relic);
    registry.restore([{ id: (RELIC_CATALOGUE[1] as Relic).id }]);

    expect(registry.ownedIds()).toEqual([(RELIC_CATALOGUE[1] as Relic).id]);
  });
});

/* ===== RunController.RelicRegistryPort (finding CR-1) ===== */

describe('RelicRegistry as the run controller port', () => {
  it('satisfies the four members the port declares', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });

    expect(typeof registry.snapshotRelics).toBe('function');
    expect(typeof registry.restoreRelics).toBe('function');
    expect(typeof registry.resolveRelic).toBe('function');
    expect(typeof registry.relicBoardSize).toBe('function');
  });

  it('snapshots the held relics in pickup order', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });
    const taken = RELIC_CATALOGUE.slice(0, 2);

    for (const relic of taken) {
      registry.pickUp(relic);
    }

    expect(registry.snapshotRelics().map((entry) => entry.id)).toEqual(
      taken.map((relic) => relic.id),
    );
  });

  it('restores through the port and dispatches the restored relics', () => {
    const bus = createHookBus();
    const registry = new RelicRegistry({ bus });
    const relic = RELIC_CATALOGUE[0] as Relic;

    registry.restoreRelics([{ id: relic.id }]);

    expect(bus.subscribers().map((entry) => entry.id)).toEqual([relic.id]);
  });

  it('PICKS UP the relic a reward resolves, so its handlers begin dispatching', () => {
    const bus = createHookBus();
    const registry = new RelicRegistry({ bus });
    const relic = RELIC_CATALOGUE[3] as Relic;

    const persisted = registry.resolveRelic(relic.id);

    expect(persisted?.id).toBe(relic.id);
    expect(registry.has(relic.id)).toBe(true);
    expect(bus.subscribers().map((entry) => entry.id)).toContain(relic.id);
  });

  it('reports a relic already held at the charges it already carries', () => {
    const bus = createHookBus();
    const registry = new RelicRegistry({ bus });
    const charged = RELIC_CATALOGUE.find(
      (relic) => relic.charges !== undefined,
    ) as Relic;

    registry.pickUp(charged);
    bus.consumeCharge(charged.id, 1);

    expect(registry.resolveRelic(charged.id)?.charges).toBe(
      (charged.charges ?? 0) - 1,
    );
    expect(registry.size()).toBe(1);
  });

  it('reports null for an identifier the catalogue does not carry', () => {
    const registry = new RelicRegistry({ bus: createHookBus() });

    expect(registry.resolveRelic('no-such-relic')).toBeNull();
    expect(registry.resolveRelic('')).toBeNull();
  });

  it('reads a declared board size out of any relic state, naming no relic', () => {
    const registry = new RelicRegistry();

    expect(
      registry.relicBoardSize([{ id: 'anything', state: { boardSize: 3 } }]),
    ).toBe(3);
  });

  it('takes the SMALLEST declaration when two relics declare one', () => {
    const registry = new RelicRegistry();

    expect(
      registry.relicBoardSize([
        { id: 'first', state: { boardSize: 3 } },
        { id: 'second', state: { boardSize: 2 } },
        { id: 'third', state: { boardSize: 4 } },
      ]),
    ).toBe(2);
  });

  it('reports nothing where no entry declares a usable size', () => {
    const registry = new RelicRegistry();

    expect(registry.relicBoardSize([])).toBeUndefined();
    expect(registry.relicBoardSize([{ id: 'plain' }])).toBeUndefined();
    expect(
      registry.relicBoardSize([{ id: 'plain', state: 0 }]),
    ).toBeUndefined();
    expect(
      registry.relicBoardSize([{ id: 'plain', state: { boardSize: 'three' } }]),
    ).toBeUndefined();
    expect(
      registry.relicBoardSize([{ id: 'plain', state: { boardSize: 2.5 } }]),
    ).toBeUndefined();
    expect(
      registry.relicBoardSize([{ id: 'plain', state: { boardSize: 0 } }]),
    ).toBeUndefined();
    expect(
      registry.relicBoardSize([{ id: 'plain', state: [3] }]),
    ).toBeUndefined();
  });

  it('reads the size a cursed relic actually persists', () => {
    const bus = createHookBus();
    const registry = new RelicRegistry({ bus });
    const cursed = RELIC_CATALOGUE.find(
      (relic) => relic.id === 'collapsing-vault',
    ) as Relic;

    // The entry the run envelope carried after a collapse.
    const persisted: readonly PersistedRelic[] = [
      { id: cursed.id, state: { boardSize: 3 } },
    ];

    expect(registry.relicBoardSize(persisted)).toBe(3);
  });
});

/* ==========================================================================
 * Harness
 * ========================================================================== */

/** A registry over a real bus, and the bus itself. */
interface Bench {
  readonly registry: RelicRegistry;
  readonly bus: HookBus;
}

/**
 * Builds a registry over a real bus.
 *
 * @param catalogue Pool to resolve identifiers against; the real catalogue
 *   where absent.
 * @returns The registry and the bus it registers with.
 */
function bench(catalogue?: readonly Relic[]): Bench {
  const bus = createHookBus();
  const registry = new RelicRegistry(
    catalogue === undefined ? { bus } : { bus, catalogue },
  );

  return { registry, bus };
}

/** Counters a registry reports into, in call order. */
interface Counted {
  readonly metrics: string[];
  readonly registry: RelicRegistry;
}

/**
 * Builds a registry whose counter names are recorded.
 *
 * @returns The recorded names and the registry.
 */
function counted(): Counted {
  const metrics: string[] = [];
  const bus = createHookBus();
  const registry = new RelicRegistry({
    bus,
    reporter: {
      onCount: (entry): void => {
        metrics.push(entry.metric);
      },
    },
  });

  return { metrics, registry };
}

/** A declaration the real catalogue does not carry. */
function adHoc(overrides: Partial<Relic> = {}): Relic {
  return {
    id: 'ad-hoc-relic',
    name: 'Ad Hoc',
    rarity: RARITIES[0],
    description: 'Declared by a caller rather than by a family module.',
    hooks: { onMerge: (payload) => payload },
    ...overrides,
  } as Relic;
}

/** The first relic in the real catalogue that carries a charge budget. */
function chargedId(): string {
  const found = RELIC_CATALOGUE.find(
    (relic): boolean => relic.charges !== undefined,
  );

  expect(found, 'the catalogue carries a charge-limited relic').toBeDefined();

  return (found as Relic).id;
}

/** The first relic in the real catalogue that carries no charge budget. */
function unlimitedId(): string {
  const found = RELIC_CATALOGUE.find(
    (relic): boolean => relic.charges === undefined,
  );

  expect(found, 'the catalogue carries an unlimited relic').toBeDefined();

  return (found as Relic).id;
}

/* ==========================================================================
 * N1 — a copied state slot never re-parents itself
 * ========================================================================== */

describe('state copying is prototype-safe', () => {
  it('keeps an own __proto__ member off the copy and off the prototype', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "keep": 1}');
    const { registry } = bench([adHoc({ state: hostile })]);

    registry.pickUp('ad-hoc-relic');

    const slot = registry.find('ad-hoc-relic')?.state as Record<
      string,
      unknown
    >;

    expect(slot).toBeDefined();
    expect(slot['keep']).toBe(1);

    // The member is refused outright rather than carried, and nothing reached
    // Object.prototype.
    expect(Object.prototype.hasOwnProperty.call(slot, '__proto__')).toBe(
      false,
    );

    // PROTOTYPE-LESS, which is the second half of the same measure: the copy is
    // built with `Object.create(null)`, so a member named `__proto__` cannot
    // reach a setter even if the name filter were ever bypassed. The persisted
    // loader accepts a null-prototype slot, so this still round-trips.
    expect(Object.getPrototypeOf(slot)).toBeNull();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses constructor and prototype members too', () => {
    const hostile = JSON.parse(
      '{"constructor": 1, "prototype": 2, "kept": 3}',
    );
    const { registry } = bench([adHoc({ state: hostile })]);

    registry.pickUp('ad-hoc-relic');

    const slot = registry.find('ad-hoc-relic')?.state as Record<
      string,
      unknown
    >;

    expect(Object.keys(slot)).toEqual(['kept']);
  });

  it('carries a reserved name through a restore without polluting', () => {
    const { registry } = bench();
    const id = unlimitedId();
    const entry: PersistedRelic = JSON.parse(
      `{"id": "${id}", "state": {"__proto__": {"bad": true}, "ok": 5}}`,
    );

    registry.restore([entry]);

    const slot = registry.find(id)?.state as Record<string, unknown>;

    expect(slot['ok']).toBe(5);
    expect(({} as Record<string, unknown>)['bad']).toBeUndefined();
  });
});

/* ==========================================================================
 * N2 — no accessor and no proxy trap runs on a public path
 * ========================================================================== */

describe('untrusted input is read as data alone', () => {
  it('never invokes an accessor on a persisted entry', () => {
    const { registry } = bench();
    const id = unlimitedId();
    let reads = 0;
    const entry = {} as PersistedRelic;

    Object.defineProperty(entry, 'id', {
      get: (): string => {
        reads += 1;

        return id;
      },
      enumerable: true,
      configurable: true,
    });

    expect(() => registry.restore([entry])).not.toThrow();

    // The accessor never ran, so the entry read as carrying no identifier.
    expect(reads).toBe(0);
    expect(registry.size()).toBe(0);
  });

  it('never invokes an accessor on a state slot', () => {
    const { registry } = bench();
    const id = unlimitedId();
    let reads = 0;
    const state: Record<string, unknown> = { plain: 1 };

    Object.defineProperty(state, 'trap', {
      get: (): number => {
        reads += 1;

        return 2;
      },
      enumerable: true,
      configurable: true,
    });

    registry.restore([{ id, state } as PersistedRelic]);

    expect(reads).toBe(0);
    expect(registry.find(id)?.state).toEqual({ plain: 1 });
  });

  it('runs no trap on a Proxy standing in for the persisted array', () => {
    const { registry } = bench();
    const traps: string[] = [];
    const hostile = new Proxy([] as PersistedRelic[], {
      get: (target, property, receiver): unknown => {
        traps.push(String(property));

        return Reflect.get(target, property, receiver);
      },
      ownKeys: (target): ArrayLike<string | symbol> => {
        traps.push('ownKeys');

        return Reflect.ownKeys(target);
      },
    });

    expect(() => registry.restore(hostile)).not.toThrow();
    expect(traps).toEqual([]);
    expect(registry.size()).toBe(0);
  });

  it('runs no trap on a Proxy standing in for a declaration', () => {
    const { registry } = bench();
    const traps: string[] = [];
    const hostile = new Proxy(adHoc(), {
      get: (target, property, receiver): unknown => {
        traps.push(String(property));

        return Reflect.get(target, property, receiver);
      },
    });

    registry.pickUp(hostile);

    expect(traps).toEqual([]);
  });

  it('bounds the walk over an over-long persisted array', () => {
    const { registry } = bench();
    const entries: PersistedRelic[] = [];

    for (let index = 0; index < 200; index += 1) {
      entries.push({ id: `absent-${index}` });
    }

    expect(() => registry.restore(entries)).not.toThrow();
    expect(registry.size()).toBe(0);
  });

  it('accepts every malformed input without raising', () => {
    const { registry } = bench();

    expect(() => registry.restore(null)).not.toThrow();
    expect(() => registry.restore(undefined)).not.toThrow();
    expect(() =>
      registry.restore('nope' as unknown as PersistedRelic[]),
    ).not.toThrow();
    expect(() =>
      registry.restore([null, undefined, 7, 'x'] as unknown as
        PersistedRelic[]),
    ).not.toThrow();
    expect(() =>
      registry.restore([{ id: 42 }] as unknown as PersistedRelic[]),
    ).not.toThrow();
    expect(() =>
      registry.restore([{ id: '' }] as unknown as PersistedRelic[]),
    ).not.toThrow();

    expect(registry.size()).toBe(0);
  });
});

/* ==========================================================================
 * M10 — a declaration the registry did not author is adopted, not held
 * ========================================================================== */

describe('injected and ad-hoc declarations are adopted', () => {
  it('does not modify the caller s array or its objects', () => {
    const declaration = adHoc();
    const supplied = [declaration];
    const { registry } = bench(supplied);

    expect(Object.isFrozen(supplied)).toBe(false);
    expect(Object.isFrozen(declaration)).toBe(false);
    expect(Object.isFrozen(declaration.hooks)).toBe(false);
    expect(registry.catalogue()).not.toBe(supplied);
  });

  it('freezes the adopted declaration and its handler table', () => {
    const { registry } = bench([adHoc()]);
    const adopted = registry.catalogue()[0];

    expect(Object.isFrozen(adopted)).toBe(true);
    expect(Object.isFrozen(adopted.hooks)).toBe(true);
  });

  it('ignores a later mutation of what the caller passed', () => {
    const declaration = adHoc({ name: 'Original' });
    const { registry } = bench([declaration]);

    const mutable = declaration as unknown as Record<string, unknown>;

    mutable['hooks'] = {};
    mutable['name'] = 'Rewritten';

    const adopted = registry.catalogue()[0];

    expect(adopted.name).toBe('Original');
    expect(adopted.hooks.onMerge).toBeTypeOf('function');
  });

  it('carries only the six declared hook names', () => {
    const { registry } = bench([
      adHoc({
        hooks: {
          onMerge: (payload: unknown): unknown => payload,
          seventhHook: (): void => undefined,
        } as unknown as Relic['hooks'],
      }),
    ]);

    const names = Object.keys(registry.catalogue()[0].hooks);

    expect(names).toEqual(['onMerge']);

    for (const name of names) {
      expect(HOOK_NAMES).toContain(name);
    }
  });

  it('drops a hook member that is not callable', () => {
    const { registry } = bench([
      adHoc({
        hooks: { onMerge: 'not a function' } as unknown as Relic['hooks'],
      }),
    ]);

    expect(Object.keys(registry.catalogue()[0].hooks)).toEqual([]);
  });

  it('adopts a declaration handed straight to pickUp', () => {
    const { registry } = bench([]);
    const declaration = adHoc();

    registry.pickUp(declaration);

    const held = registry.find('ad-hoc-relic');

    expect(held).toBeDefined();
    expect(held?.definition).not.toBe(declaration);
    expect(Object.isFrozen(held?.definition)).toBe(true);
    expect(Object.isFrozen(declaration)).toBe(false);
  });

  it('detaches an ad-hoc declaration s initial state slot', () => {
    const slot = { nested: { count: 1 } };
    const { registry } = bench([]);

    registry.pickUp(adHoc({ state: slot }));
    slot.nested.count = 99;

    expect(registry.find('ad-hoc-relic')?.state).toEqual({
      nested: { count: 1 },
    });
  });

  it('drops an injected entry that is not a usable declaration', () => {
    const { registry } = bench([
      adHoc(),
      null as unknown as Relic,
      { id: '' } as Relic,
      { id: 'no-hooks' } as Relic,
    ]);

    expect(registry.catalogue().map((relic): string => relic.id)).toEqual([
      'ad-hoc-relic',
    ]);
  });

  it('uses the real catalogue as it stands, already frozen', () => {
    const { registry } = bench();

    expect(registry.catalogue()).toBe(RELIC_CATALOGUE);

    for (const relic of RELIC_CATALOGUE) {
      expect(Object.isFrozen(relic)).toBe(true);
      expect(Object.isFrozen(relic.hooks)).toBe(true);
    }
  });
});

/* ==========================================================================
 * M9a — what a reader receives is detached from what the registry holds
 * ========================================================================== */

describe('returned records are detached', () => {
  it('freezes every record active() hands back', () => {
    const { registry } = bench();

    registry.pickUp(chargedId());

    const held = registry.active();

    expect(Object.isFrozen(held)).toBe(true);
    expect(held).toHaveLength(1);
    expect(Object.isFrozen(held[0])).toBe(true);
  });

  it('does not let a write through active() reach the registry', () => {
    const { registry } = bench();
    const id = chargedId();

    registry.pickUp(id);

    const before = registry.find(id)?.charges;
    const escaped = registry.active()[0] as { charges?: number };

    expect(() => {
      escaped.charges = 4242;
    }).toThrow();

    expect(registry.find(id)?.charges).toBe(before);
    expect(registry.serialize()[0].charges).toBe(before);
  });

  it('hands back a different object on each call', () => {
    const { registry } = bench();

    registry.pickUp(unlimitedId());

    expect(registry.active()[0]).not.toBe(registry.active()[0]);
    expect(registry.find(unlimitedId())).not.toBe(
      registry.find(unlimitedId()),
    );
  });

  it('does not let a write through find().state reach the registry', () => {
    const { registry } = bench([adHoc({ state: { count: 1 } })]);

    registry.pickUp('ad-hoc-relic');

    const slot = registry.find('ad-hoc-relic')?.state as {
      count: number;
    };

    slot.count = 77;

    expect(registry.find('ad-hoc-relic')?.state).toEqual({ count: 1 });
  });

  it('does not let a write through pickUp s return reach the registry', () => {
    const { registry } = bench();
    const id = chargedId();
    const returned = registry.pickUp(id) as { charges?: number };

    expect(Object.isFrozen(returned)).toBe(true);
    expect(() => {
      returned.charges = 1;
    }).toThrow();

    expect(registry.find(id)?.charges).toBe(findRelicById(id)?.charges);
  });

  it('still reports the budget the bus holds', () => {
    const { registry, bus } = bench();
    const id = chargedId();
    const seeded = findRelicById(id)?.charges as number;

    registry.pickUp(id);
    bus.consumeCharge(id, 2);

    expect(registry.active()[0].charges).toBe(seeded - 2);
    expect(registry.find(id)?.charges).toBe(seeded - 2);
  });
});

/* ==========================================================================
 * M1 — activation is the one path a budget is spent on
 * ========================================================================== */

describe('activate spends a charge budget', () => {
  it('spends one charge by default and reports what remains', () => {
    const { registry } = bench();
    const id = chargedId();
    const seeded = findRelicById(id)?.charges as number;

    registry.pickUp(id);

    const outcome = registry.activate(id);

    expect(outcome.held).toBe(true);
    expect(outcome.limited).toBe(true);
    expect(outcome.consumed).toBe(1);
    expect(outcome.remaining).toBe(seeded - 1);
  });

  it('spends an explicit amount', () => {
    const { registry } = bench();
    const id = chargedId();
    const seeded = findRelicById(id)?.charges as number;

    registry.pickUp(id);

    expect(registry.activate(id, 2).remaining).toBe(seeded - 2);
  });

  it('carries the spent budget into serialize()', () => {
    const { registry } = bench();
    const id = chargedId();
    const seeded = findRelicById(id)?.charges as number;

    registry.pickUp(id);
    registry.activate(id, 3);

    const entry = registry.serialize()[0];

    expect(entry.id).toBe(id);
    expect(entry.charges).toBe(seeded - 3);
  });

  it('stops the relic firing once the budget is exhausted', () => {
    const { registry, bus } = bench();
    const id = chargedId();
    const seeded = findRelicById(id)?.charges as number;

    registry.pickUp(id);

    for (let spent = 0; spent < seeded; spent += 1) {
      expect(registry.activate(id).consumed).toBe(1);
    }

    expect(registry.find(id)?.charges).toBe(0);

    // Exhausted: nothing more is spent, and the bus reports the same.
    const exhausted = registry.activate(id);

    expect(exhausted.held).toBe(true);
    expect(exhausted.consumed).toBe(0);
    expect(exhausted.remaining).toBe(0);
    expect(bus.consumeCharge(id, 1).consumed).toBe(0);
  });

  it('reports an unlimited relic as held and spends nothing', () => {
    const { registry } = bench();
    const id = unlimitedId();

    registry.pickUp(id);

    const outcome = registry.activate(id);

    expect(outcome.held).toBe(true);
    expect(outcome.limited).toBe(false);
    expect(outcome.consumed).toBe(0);
    expect(registry.find(id)?.charges).toBeUndefined();
  });

  it('refuses an identifier that is not held', () => {
    const { registry } = bench();

    const outcome = registry.activate(chargedId());

    expect(outcome.held).toBe(false);
    expect(outcome.consumed).toBe(0);
  });

  it('refuses an amount that is not a positive whole number', () => {
    const { registry } = bench();
    const id = chargedId();
    const seeded = findRelicById(id)?.charges as number;

    registry.pickUp(id);

    for (const amount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const outcome = registry.activate(id, amount);

      expect(outcome.consumed).toBe(0);
      expect(outcome.held).toBe(true);
    }

    expect(registry.find(id)?.charges).toBe(seeded);
  });

  it('raises nothing and spends nothing on a registry with no bus', () => {
    const registry = new RelicRegistry();
    const id = chargedId();

    registry.pickUp(id);

    const outcome = registry.activate(id);

    expect(outcome.held).toBe(true);
    expect(outcome.consumed).toBe(0);
    expect(registry.find(id)?.charges).toBe(findRelicById(id)?.charges);
  });

  it('reports activation, exhaustion and refusal separately', () => {
    const { metrics, registry } = counted();
    const id = chargedId();

    registry.activate(id);
    registry.pickUp(id);
    registry.activate(id, 0);
    registry.activate(id);

    expect(metrics).toContain('relics.activate.unknown');
    expect(metrics).toContain('relics.activate.refused');
    expect(metrics).toContain('relics.activate');
  });
});

/* ==========================================================================
 * C1a — the surface a run controller binds
 * ========================================================================== */

describe('the surface a run controller binds', () => {
  it('reports whether the catalogue knows an identifier', () => {
    const { registry } = bench();

    expect(registry.knows(unlimitedId())).toBe(true);
    expect(registry.knows('no-such-relic')).toBe(false);
    expect(registry.knows('')).toBe(false);
  });

  it('separates knowing a relic from holding it', () => {
    const { registry } = bench();
    const id = unlimitedId();

    expect(registry.knows(id)).toBe(true);
    expect(registry.has(id)).toBe(false);

    registry.pickUp(id);

    expect(registry.has(id)).toBe(true);
  });

  it('resolves one held relic to the entry to persist', () => {
    const { registry } = bench();
    const id = chargedId();

    registry.pickUp(id);

    const entry = registry.persistedEntry(id);

    expect(entry?.id).toBe(id);
    expect(entry?.charges).toBe(findRelicById(id)?.charges);
  });

  it('yields null for a relic that is not held', () => {
    const { registry } = bench();

    expect(registry.persistedEntry(unlimitedId())).toBeNull();
    expect(registry.persistedEntry('no-such-relic')).toBeNull();
  });

  it('reflects a spent charge in the entry to persist', () => {
    const { registry } = bench();
    const id = chargedId();
    const seeded = findRelicById(id)?.charges as number;

    registry.pickUp(id);
    registry.activate(id);

    expect(registry.persistedEntry(id)?.charges).toBe(seeded - 1);
  });

  it('round-trips the held set through serialize and restore', () => {
    const first = bench();
    const charged = chargedId();
    const unlimited = unlimitedId();

    first.registry.pickUp(unlimited);
    first.registry.pickUp(charged);
    first.registry.activate(charged, 2);

    const persisted = first.registry.serialize();
    const second = bench();

    second.registry.restore(persisted);

    // Pickup order survives, and so does the spent budget.
    expect(second.registry.ownedIds()).toEqual([unlimited, charged]);
    expect(second.registry.find(charged)?.charges).toBe(
      (findRelicById(charged)?.charges as number) - 2,
    );
    expect(second.registry.serialize()).toEqual(persisted);
  });

  it('keeps pickup order as acquisition order for the bus', () => {
    const { registry, bus } = bench();
    const ids = RELIC_CATALOGUE.slice(0, 3)
      .map((relic): string => relic.id)
      .reverse();

    for (const id of ids) {
      registry.pickUp(id);
    }

    expect(registry.ownedIds()).toEqual(ids);
    expect(
      bus.subscribers().map((subscriber): string => subscriber.id),
    ).toEqual(ids);
  });

  it('refuses a relic already held', () => {
    const { registry } = bench();
    const id = unlimitedId();

    expect(registry.pickUp(id)).toBeDefined();
    expect(registry.pickUp(id)).toBeUndefined();
    expect(registry.size()).toBe(1);
  });

  it('refuses an identifier the catalogue does not carry', () => {
    const { registry } = bench();

    expect(registry.pickUp('no-such-relic')).toBeUndefined();
    expect(registry.size()).toBe(0);
  });

  it('unregisters every relic on clear', () => {
    const { registry, bus } = bench();

    registry.pickUp(unlimitedId());
    registry.pickUp(chargedId());
    registry.clear();

    expect(registry.size()).toBe(0);
    expect(registry.ownedIds()).toEqual([]);
    expect(bus.subscribers()).toHaveLength(0);
  });

  it('raises nothing through any public entry point', () => {
    const registry = new RelicRegistry();

    expect(() => {
      registry.active();
      registry.find('');
      registry.has('');
      registry.knows('');
      registry.ownedIds();
      registry.size();
      registry.catalogue();
      registry.degradedIds();
      registry.serialize();
      registry.persistedEntry('');
      registry.relicContext();
      registry.commitContextProvider()();
      registry.activate('');
      registry.reporterFaults();
      registry.clear();
    }).not.toThrow();
  });
});

/* ==========================================================================
 * The state slot and the run port, contract-pinned
 * ==========================================================================
 *
 * A third suite, kept whole beside the two above. It builds its own registries
 * through its own `harness()`, so it observes none of their held relics, and it
 * covers the two boundaries reachable from outside this folder that neither of
 * the others pins: the state slot the registry COPIES, and the port a run
 * controller drives it through.
 */

/* ==========================================================================
 * Harness
 * ========================================================================== */

/** Correlation identifier every registry below is constructed with. */
const CORRELATION_ID = 'registry-suite';

/** A relic with two hooks, a charge budget and an initial state slot. */
const CHARGED_RELIC_ID = 'temporal-anchor';

/** A relic with one hook, no charge budget and no state slot. */
const PLAIN_RELIC_ID = 'echo-chamber';

/** Relics the catalogue carries, per AAP A1. */
const CATALOGUE_SIZE = 16;

interface Harness {
  readonly registry: RelicRegistry;
  readonly bus: HookBus;
  readonly port: RelicRunPort;
}

function harness(catalogue?: readonly Relic[]): Harness {
  const bus = createHookBus({ correlationId: CORRELATION_ID });
  const registry = new RelicRegistry({
    bus,
    correlationId: CORRELATION_ID,
    ...(catalogue === undefined ? {} : { catalogue }),
  });

  return { registry, bus, port: registry.runPort() };
}

/** The identifiers registered on the bus, in pickup order. */
function registeredIds(bus: HookBus): readonly string[] {
  return bus.subscribers().map((subscriber): string => subscriber.id);
}

/** A relic declaration carrying `state`, for the copy assertions. */
function relicWithState(id: string, state: unknown): Relic {
  return {
    id,
    name: id,
    rarity: 'common',
    description: id,
    hooks: { onMerge: (): void => undefined },
    state,
  };
}

/* ==========================================================================
 * 1. The state copy is total against a hostile slot (F-06)
 * ========================================================================== */

describe('the state copy contains every reflection it performs', () => {
  it('accepts a proxy whose ownKeys trap throws, holding no state', () => {
    const hostile = new Proxy(
      { safe: 1 },
      {
        ownKeys(): string[] {
          throw new Error('ownKeys refused');
        },
      },
    );
    const { registry, port } = harness([
      relicWithState('hostile-keys', hostile),
    ]);

    expect(() => port.pickUpRelic('hostile-keys')).not.toThrow();
    expect(registry.has('hostile-keys')).toBe(true);
    expect(registry.find('hostile-keys')?.state).toEqual({});
  });

  it('accepts a proxy whose descriptor trap throws, dropping the member', () => {
    const hostile = new Proxy(
      { kept: 1, refused: 2 },
      {
        getOwnPropertyDescriptor(
          target: Record<string, unknown>,
          name: string | symbol,
        ): PropertyDescriptor | undefined {
          if (name === 'refused') {
            throw new Error('descriptor refused');
          }

          return Object.getOwnPropertyDescriptor(target, name);
        },
      },
    );
    const { registry, port } = harness([
      relicWithState('hostile-descriptor', hostile),
    ]);

    expect(() => port.pickUpRelic('hostile-descriptor')).not.toThrow();
    expect(registry.find('hostile-descriptor')?.state).toEqual({ kept: 1 });
  });

  it('accepts a revoked proxy, holding no state', () => {
    const revocable = Proxy.revocable({ gone: 1 }, {});

    revocable.revoke();

    const { registry, port } = harness([
      relicWithState('revoked', revocable.proxy),
    ]);

    expect(() => port.pickUpRelic('revoked')).not.toThrow();
    expect(registry.has('revoked')).toBe(true);
    expect(registry.find('revoked')?.state).toEqual({});
  });

  it('accepts an array proxy whose element read throws', () => {
    const entries = [1, 2, 3];
    const hostile = new Proxy(entries, {
      get(
        target: number[],
        name: string | symbol,
      ): unknown {
        if (name === '1') {
          throw new Error('element refused');
        }

        return Reflect.get(target, name);
      },
    });
    const { registry, port } = harness([
      relicWithState('hostile-element', { list: hostile }),
    ]);

    expect(() => port.pickUpRelic('hostile-element')).not.toThrow();

    // The refused element is carried as `null`, exactly as `JSON.stringify`
    // writes a value it cannot carry, so every later element keeps its index.
    expect(registry.find('hostile-element')?.state).toEqual({
      list: [1, null, 3],
    });
  });

  it('never invokes an accessor while copying a slot', () => {
    let reads = 0;
    const slot = {
      plain: 'kept',

      get trap(): string {
        reads += 1;

        return 'invoked';
      },
    };
    const { registry, port } = harness([relicWithState('accessor', slot)]);

    port.pickUpRelic('accessor');

    expect(reads).toBe(0);
    expect(registry.find('accessor')?.state).toEqual({ plain: 'kept' });
  });
});

describe('the state copy refuses the reserved member names', () => {
  it('drops __proto__, constructor and prototype from a restored slot', () => {
    const { registry, port } = harness();
    const hostile = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":1,"prototype":2,"kept":3}',
    ) as Record<string, unknown>;

    port.restoreRelics([{ id: CHARGED_RELIC_ID, state: hostile }]);

    const state = registry.find(CHARGED_RELIC_ID)?.state as Record<
      string,
      unknown
    >;

    expect(state).toEqual({ kept: 3 });
    expect(Object.getOwnPropertyNames(state)).toEqual(['kept']);
  });

  it('leaves Object.prototype unpolluted and the copy prototype-less', () => {
    // No bus, so the record read back is the registry's own copy rather than
    // the slot src/engine/hook-bus.ts owns and re-copies.
    const registry = new RelicRegistry({ correlationId: CORRELATION_ID });
    const port = registry.runPort();
    const hostile = JSON.parse('{"__proto__":{"polluted":"yes"}}') as Record<
      string,
      unknown
    >;

    port.restoreRelics([{ id: CHARGED_RELIC_ID, state: hostile }]);

    const state = registry.find(CHARGED_RELIC_ID)?.state as object;

    // The copy carries no prototype at all, so no member name written into it
    // can reach prototype machinery.
    expect(Object.getPrototypeOf(state)).toBeNull();

    // The entry that reaches the run envelope carries the same property.
    expect(
      Object.getPrototypeOf(port.snapshotRelics()[0].state as object),
    ).toBeNull();
    expect(
      ({} as Record<string, unknown>)['polluted'],
    ).toBeUndefined();
    expect(
      (Object.prototype as unknown as Record<string, unknown>)['polluted'],
    ).toBeUndefined();
  });

  it('survives the round trip the run envelope makes of the copy', () => {
    const { registry, port } = harness();

    port.restoreRelics([
      { id: CHARGED_RELIC_ID, state: { score: 12, board: null } },
    ]);

    const projected = port.snapshotRelics();

    expect(JSON.parse(JSON.stringify(projected))).toEqual([
      { id: CHARGED_RELIC_ID, charges: 3, state: { score: 12, board: null } },
    ]);
    expect(registry.has(CHARGED_RELIC_ID)).toBe(true);
  });
});

describe('restore is total against a hostile entry list', () => {
  it('accepts a list whose element read throws, loading what it can', () => {
    const { registry, port } = harness();
    const entries: PersistedRelic[] = [
      { id: CHARGED_RELIC_ID },
      { id: PLAIN_RELIC_ID },
    ];
    const hostile = new Proxy(entries, {
      get(target: PersistedRelic[], name: string | symbol): unknown {
        if (name === '0') {
          throw new Error('entry refused');
        }

        return Reflect.get(target, name);
      },
    });

    // NEITHER RAISES NOR RUNS THE TRAP. Every element is read through
    // `Object.getOwnPropertyDescriptor` rather than by indexing, so a `get` trap
    // written to raise is never invoked: the entry loads from its own data
    // descriptor, and a list that would have thrown out of `restore()` loads
    // whole instead of losing an element to the trap.
    expect(() => port.restoreRelics(hostile)).not.toThrow();
    expect(registry.ownedIds()).toEqual([CHARGED_RELIC_ID, PLAIN_RELIC_ID]);
  });

  it('accepts an entry whose id accessor throws, skipping it', () => {
    const { registry, port } = harness();
    const hostile = {
      get id(): string {
        throw new Error('id refused');
      },
    } as unknown as PersistedRelic;

    expect(() =>
      port.restoreRelics([hostile, { id: PLAIN_RELIC_ID }]),
    ).not.toThrow();
    expect(registry.ownedIds()).toEqual([PLAIN_RELIC_ID]);
  });

  it('accepts a revoked proxy in place of the whole list', () => {
    const revocable = Proxy.revocable([{ id: PLAIN_RELIC_ID }], {});

    revocable.revoke();

    const { registry, port } = harness();

    expect(() => port.restoreRelics(revocable.proxy)).not.toThrow();
    expect(registry.ownedIds()).toEqual([]);
  });
});

/* ==========================================================================
 * 2. The run port is the live pickup route (F-02)
 * ========================================================================== */

describe('runPort satisfies the run controller port', () => {
  it('is assignable to RelicRegistryPort with every member present', () => {
    const { port } = harness();

    // The assignment IS the assertion: the two declarations are structural
    // counterparts, so a member renamed on either side fails to compile here.
    const controllerPort: RelicRegistryPort = port;

    expect(typeof controllerPort.snapshotRelics).toBe('function');
    expect(typeof controllerPort.restoreRelics).toBe('function');
    expect(typeof controllerPort.resolveRelic).toBe('function');
    expect(typeof controllerPort.knowsRelic).toBe('function');
    expect(typeof controllerPort.pickUpRelic).toBe('function');
    expect(typeof controllerPort.holdsRelic).toBe('function');
    expect(Object.isFrozen(port)).toBe(true);
  });

  it('reads catalogue membership, and nothing else, through knowsRelic', () => {
    const { port } = harness();

    expect(RELIC_CATALOGUE).toHaveLength(CATALOGUE_SIZE);

    for (const relic of RELIC_CATALOGUE) {
      expect(port.knowsRelic(relic.id)).toBe(true);
    }

    expect(port.knowsRelic('not-a-relic')).toBe(false);
    expect(port.knowsRelic('')).toBe(false);
    expect(port.knowsRelic(undefined as unknown as string)).toBe(false);
    expect(port.knowsRelic('__proto__')).toBe(false);
  });

  it('registers the relic with the bus as it is picked up', () => {
    const { bus, port } = harness();

    expect(registeredIds(bus)).toEqual([]);

    const entry = port.pickUpRelic(CHARGED_RELIC_ID);

    expect(entry).not.toBeNull();
    expect(entry?.id).toBe(CHARGED_RELIC_ID);
    expect(registeredIds(bus)).toEqual([CHARGED_RELIC_ID]);
    expect(port.holdsRelic(CHARGED_RELIC_ID)).toBe(true);

    // Both bindings of a two-hook relic are live from the one registration.
    expect(bus.subscriptions('onBeforeMove')).toHaveLength(1);
    expect(bus.subscriptions('onAfterMove')).toHaveLength(1);
  });

  it('seeds the declared charge budget onto the entry it returns', () => {
    const { port } = harness();
    const declared = findRelicById(CHARGED_RELIC_ID)?.charges;

    expect(port.pickUpRelic(CHARGED_RELIC_ID)?.charges).toBe(declared);
    expect(port.pickUpRelic(PLAIN_RELIC_ID)?.charges).toBeUndefined();
  });

  it('refuses an unknown identifier, a repeat and a hostile value', () => {
    const { bus, port } = harness();

    expect(port.pickUpRelic('not-a-relic')).toBeNull();
    expect(port.pickUpRelic('')).toBeNull();
    expect(port.pickUpRelic(undefined as unknown as string)).toBeNull();
    expect(port.pickUpRelic({} as unknown as string)).toBeNull();
    expect(registeredIds(bus)).toEqual([]);

    expect(port.pickUpRelic(PLAIN_RELIC_ID)).not.toBeNull();
    expect(port.pickUpRelic(PLAIN_RELIC_ID)).toBeNull();
    expect(registeredIds(bus)).toEqual([PLAIN_RELIC_ID]);
  });

  it('keeps pickup order across pickups and projections', () => {
    const { port } = harness();

    port.pickUpRelic(PLAIN_RELIC_ID);
    port.pickUpRelic(CHARGED_RELIC_ID);

    expect(port.snapshotRelics().map((relic) => relic.id)).toEqual([
      PLAIN_RELIC_ID,
      CHARGED_RELIC_ID,
    ]);
  });

  it('resolves a held relic and refuses one that is not held', () => {
    const { port } = harness();

    expect(port.resolveRelic(CHARGED_RELIC_ID)).toBeNull();

    port.pickUpRelic(CHARGED_RELIC_ID);

    expect(port.resolveRelic(CHARGED_RELIC_ID)?.id).toBe(CHARGED_RELIC_ID);
    expect(port.resolveRelic('not-a-relic')).toBeNull();
  });

  it('reads through to the registry rather than capturing a snapshot', () => {
    const { registry, port } = harness();

    expect(port.holdsRelic(PLAIN_RELIC_ID)).toBe(false);

    registry.pickUp(PLAIN_RELIC_ID);

    expect(port.holdsRelic(PLAIN_RELIC_ID)).toBe(true);
    expect(port.snapshotRelics().map((relic) => relic.id)).toEqual([
      PLAIN_RELIC_ID,
    ]);
  });

  it('unregisters every relic a cleared run held', () => {
    const { registry, bus, port } = harness();

    port.pickUpRelic(PLAIN_RELIC_ID);
    port.pickUpRelic(CHARGED_RELIC_ID);
    registry.clear();

    expect(registeredIds(bus)).toEqual([]);
    expect(port.snapshotRelics()).toEqual([]);
    expect(port.holdsRelic(PLAIN_RELIC_ID)).toBe(false);
  });
});
