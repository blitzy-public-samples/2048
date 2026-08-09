// The load half of the board-shrink contract: a run resumed after a
// board-mutating relic collapsed the board must rebuild the lattice at the
// size the relic left it, not the size the saved snapshot carried.
//
// The store is injected over `MemoryStorage`, so every case behaves
// identically in the DOM-free and the jsdom project and one test's storage
// never reaches the next.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { createHookBus } from '../../../src/engine/hook-bus';
import { RelicRegistry } from '../../../src/relics/relic-registry';
import { RunController, resolveRunIdentity } from '../../../src/run/run-controller';
import {
  RUN_STATE_SCHEMA_VERSION,
  type PersistedRelic,
  type RunReporter,
  type RunState,
} from '../../../src/run/run-state';
import { RunStateStore } from '../../../src/run/run-state-store';
import { LocalStorageManager } from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import { RUN_STATE_KEY } from '../../../src/storage/storage-keys';

const CURSED_ID = 'collapsing-vault';

const SAVED_SIZE = 4;

const COLLAPSED_SIZE = 3;

/** A stored envelope carrying a 4x4 board and the relics the caller names. */
function storedEnvelope(relics: readonly PersistedRelic[]): RunState {
  const cells = Array.from({ length: SAVED_SIZE }, (_column, x) =>
    Array.from({ length: SAVED_SIZE }, (_cell, y) =>
      x === y ? { position: { x, y }, value: 2 * (x + 1) } : null,
    ),
  );

  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: 'run-under-test',
    seed: 'collapse-reload-seed',
    rngCursor: {
      'spawn-value': 4,
      'spawn-position': 4,
      'relic-draw': 2,
      'rarity-weight': 2,
    },
    stageIndex: 1,
    stageGoal: { kind: 'highest-tile', target: 64 },
    goalProgress: 0.5,
    relics,
    board: {
      grid: { size: SAVED_SIZE, cells },
      score: 240,
      over: false,
      won: false,
      keepPlaying: false,
    },
  };
}

interface Loaded {
  readonly controller: RunController;
  readonly appliedSizes: number[];
  readonly boardSize: number;
  readonly restored: readonly string[];
}

/**
 * Writes an envelope, composes a controller with a real registry over it and
 * calls `begin`, reporting what the load reconciled to.
 *
 * @param relics Relic entries the stored envelope carries.
 * @param configuredSize Edge length the rules declare at load time.
 * @param withRegistry Whether a registry is supplied at all.
 * @returns What the load produced.
 */
function loadWith(
  relics: readonly PersistedRelic[],
  configuredSize = SAVED_SIZE,
  withRegistry = true,
): Loaded {
  const backing = new MemoryStorage();

  backing.setItem(RUN_STATE_KEY, JSON.stringify(storedEnvelope(relics)));

  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();

  config.boardSize = configuredSize;

  const appliedSizes: number[] = [];
  const reporter: RunReporter = {
    onBoardSizeReconciled(report): void {
      appliedSizes.push(report.appliedSize);
    },
  };

  const registry = new RelicRegistry({ bus: createHookBus() });
  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config, reporter }),
    identity: resolveRunIdentity({
      storage: manager,
      createToken: () => 'token-0',
    }),
    config,
    reporter,
    ...(withRegistry ? { relics: registry } : {}),
  });

  controller.begin();

  return {
    controller,
    appliedSizes,
    boardSize: controller.state().board.grid.size,
    restored: registry.ownedIds(),
  };
}

describe('board size implied by a persisted relic', () => {
  it('rebuilds the lattice at the size the relic recorded', () => {
    const loaded = loadWith([
      { id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } },
    ]);

    expect(loaded.boardSize).toBe(COLLAPSED_SIZE);
  });

  it('OUTWEIGHS the configured size, so a reload does not undo the collapse', () => {
    // The rules arrive fresh at 4 after a reload; the relic says 3.
    const loaded = loadWith(
      [{ id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } }],
      SAVED_SIZE,
    );

    expect(loaded.boardSize).toBe(COLLAPSED_SIZE);
    expect(loaded.appliedSizes).toContain(COLLAPSED_SIZE);
  });

  it('keeps every surviving tile in the exact cell it occupied', () => {
    const loaded = loadWith([
      { id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } },
    ]);
    const cells = loaded.controller.state().board.grid.cells;

    for (let x = 0; x < COLLAPSED_SIZE; x += 1) {
      for (let y = 0; y < COLLAPSED_SIZE; y += 1) {
        const cell = cells[x]?.[y] ?? null;

        if (x === y) {
          expect(cell).toEqual({ position: { x, y }, value: 2 * (x + 1) });
        } else {
          expect(cell).toBeNull();
        }
      }
    }
  });

  it('drops the tiles that fell outside the collapsed board', () => {
    const loaded = loadWith([
      { id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } },
    ]);
    const cells = loaded.controller.state().board.grid.cells;

    expect(cells).toHaveLength(COLLAPSED_SIZE);

    for (const column of cells) {
      expect(column).toHaveLength(COLLAPSED_SIZE);
    }
  });

  it('restores the relic itself, so the collapse stays in force', () => {
    const loaded = loadWith([
      { id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } },
    ]);

    expect(loaded.restored).toContain(CURSED_ID);
  });

  it('loads at the configured size when no relic declares one', () => {
    const loaded = loadWith([{ id: 'twin-seed' }]);

    expect(loaded.boardSize).toBe(SAVED_SIZE);
  });

  it('loads at the configured size when no relic is held at all', () => {
    const loaded = loadWith([]);

    expect(loaded.boardSize).toBe(SAVED_SIZE);
  });

  it('takes the SMALLEST size when two relics declare one', () => {
    const loaded = loadWith([
      { id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } },
      { id: 'twin-seed', state: { boardSize: 2 } },
    ]);

    // A board two relics have shrunk stands at the smaller of the two, and the
    // derivation names neither relic: it reads whichever declaration is
    // smallest, which is what keeps a second board-mutating relic from needing
    // a change to the reconciliation.
    expect(loaded.boardSize).toBe(2);
  });

  it('ignores a declaration that is not a usable edge length', () => {
    for (const declared of [0, -1, 2.5, 'three', null]) {
      const loaded = loadWith([
        { id: CURSED_ID, state: { boardSize: declared } },
      ]);

      expect(loaded.boardSize).toBe(SAVED_SIZE);
    }
  });

  it('reconciles from the envelope even when no registry is supplied', () => {
    const loaded = loadWith(
      [{ id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } }],
      SAVED_SIZE,
      false,
    );

    // The declaration lives in the envelope, not in the registry.
    expect(loaded.boardSize).toBe(COLLAPSED_SIZE);
    expect(loaded.appliedSizes).toContain(COLLAPSED_SIZE);

    expect(loaded.restored).toEqual([]);
  });
});

describe('RelicRegistryPort calls keep their receiver', () => {
  /**
   * Composes a controller over an empty store with a real registry attached.
   *
   * @returns The controller, the registry and every reported write failure.
   */
  function composeWithRegistry(): {
    controller: RunController;
    registry: RelicRegistry;
    failures: string[];
  } {
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const failures: string[] = [];
    const reporter: RunReporter = {
      onWriteFailed(report): void {
        failures.push(String(report.error));
      },
    };
    const registry = new RelicRegistry({ bus: createHookBus() });
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config, reporter }),
      identity: resolveRunIdentity({
        storage: manager,
        createToken: () => 'token-0',
      }),
      config,
      reporter,
      relics: registry,
    });

    controller.begin();

    return { controller, registry, failures };
  }

  it('restores the relics a stored envelope carried into the registry', () => {
    const loaded = loadWith([
      { id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } },
      { id: 'twin-seed' },
    ]);

    expect(loaded.restored).toEqual([CURSED_ID, 'twin-seed']);
  });

  it('resolves a reward through the registry, picking the relic up', () => {
    const { controller, registry, failures } = composeWithRegistry();

    // A selection is measured against the offer, so the offer the screen
    // presented is recorded first; a pick nothing offered is refused, which is
    // what keeps a caller from taking any relic in the catalogue at will.
    controller.recordRewardOffer(['frostbind', 'tumbler', 'twin-seed']);

    expect(controller.resolveReward('frostbind').accepted).toBe(true);
    expect(registry.has('frostbind')).toBe(true);
    expect(controller.relics().map((entry) => entry.id)).toEqual(['frostbind']);
    expect(failures).toEqual([]);
  });

  it('refuses a pick outside the offer it recorded', () => {
    const { controller, registry } = composeWithRegistry();

    controller.recordRewardOffer(['tumbler', 'twin-seed', 'alloy-forge']);

    const refused = controller.resolveReward('frostbind');

    expect(refused.accepted).toBe(false);
    expect(refused.refusal).toBe('not-offered');
    expect(registry.has('frostbind')).toBe(false);
    expect(controller.relics()).toEqual([]);

    // The offer stands after a refusal, so the same three cards are still
    // choosable and the player is not stranded.
    expect(controller.resolveReward('tumbler').accepted).toBe(true);
  });

  it('carries the charges the registry seeded into the held list', () => {
    const { controller, registry } = composeWithRegistry();

    controller.recordRewardOffer(['frostbind']);
    controller.resolveReward('frostbind');

    const budget = registry.find('frostbind')?.charges;

    expect(budget).toBeGreaterThan(0);
    expect(controller.relics()[0]?.charges).toBe(budget);
  });

  it('projects the snapshot the registry itself reports when writing', () => {
    const { controller, registry, failures } = composeWithRegistry();

    registry.pickUp('echo-chamber');

    // `state` reads the envelope in force; `projectRelics` is reached by a
    // write, so a resolved reward is what exercises it here.
    controller.recordRewardOffer(['tumbler']);
    controller.resolveReward('tumbler');

    expect(controller.relics().map((entry) => entry.id)).toContain('tumbler');
    expect(failures).toEqual([]);
  });

  it('reports no write failure across a full port round trip', () => {
    const { controller, failures } = composeWithRegistry();

    controller.recordRewardOffer(['twin-seed', 'alloy-forge']);
    controller.resolveReward('twin-seed');

    // Each reward stands on its own offer: the first selection clears the
    // offer it was taken from, so the second is recorded before it is made.
    controller.recordRewardOffer(['alloy-forge']);
    controller.resolveReward('alloy-forge');

    expect(failures).toEqual([]);
    expect(controller.relics().map((entry) => entry.id)).toEqual([
      'twin-seed',
      'alloy-forge',
    ]);
  });
});

describe('RunStateStore.peekRelics', () => {
  function storeOver(raw: string | null): RunStateStore {
    const backing = new MemoryStorage();

    if (raw !== null) {
      backing.setItem(RUN_STATE_KEY, raw);
    }

    return new RunStateStore({
      storage: new LocalStorageManager({ storage: backing }),
      config: createDefaultRulesConfig(),
    });
  }

  it('reads the stored entries in the order they were stored', () => {
    const store = storeOver(
      JSON.stringify(
        storedEnvelope([
          { id: 'twin-seed' },
          { id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } },
        ]),
      ),
    );

    expect(store.peekRelics().map((entry) => entry.id)).toEqual([
      'twin-seed',
      CURSED_ID,
    ]);
  });

  it('carries state across exactly as it was stored', () => {
    const store = storeOver(
      JSON.stringify(
        storedEnvelope([
          { id: CURSED_ID, state: { boardSize: COLLAPSED_SIZE } },
        ]),
      ),
    );

    expect(store.peekRelics()[0]?.state).toEqual({
      boardSize: COLLAPSED_SIZE,
    });
  });

  it('reconciles nothing and validates nothing beyond the shape it returns', () => {
    const store = storeOver(
      JSON.stringify({ relics: [{ id: 'off-book', state: { boardSize: 99 } }] }),
    );

    expect(store.peekRelics()).toEqual([
      { id: 'off-book', state: { boardSize: 99 } },
    ]);
  });

  it('never throws, whatever is stored', () => {
    const inputs: readonly (string | null)[] = [
      null,
      '',
      'not json',
      'null',
      '42',
      '[]',
      '{}',
      '{"relics":null}',
      '{"relics":"nope"}',
      '{"relics":[null,42,{},{"id":""},{"id":7}]}',
    ];

    for (const raw of inputs) {
      const store = storeOver(raw);

      expect(() => store.peekRelics()).not.toThrow();
      expect(store.peekRelics()).toEqual([]);
    }
  });

  it('returns a fresh array on every call', () => {
    const store = storeOver(
      JSON.stringify(storedEnvelope([{ id: CURSED_ID }])),
    );

    expect(store.peekRelics()).not.toBe(store.peekRelics());
    expect(store.peekRelics()).toEqual(store.peekRelics());
  });
});
