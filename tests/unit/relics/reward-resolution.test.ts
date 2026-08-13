// Contract suite for the ONE transition from a reward offer to a live,
// persisted relic, AAP R3 and R6.
//
// AAP R3's own key flow is that a chosen relic's effects "immediately fire on
// subsequent moves/merges/spawns for rest of run", so both halves are pinned
// here against the real controller, the real registry, a real `HookBus`, a
// real `Engine` and a real `RunStateStore` over injected memory storage.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import {
  createDefaultStageConfig,
  type StageConfig,
} from '../../../src/config/stage-config';
import { Engine } from '../../../src/engine/engine';
import { createHookBus, type HookBus } from '../../../src/engine/hook-bus';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  type Direction,
} from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';
import { MERGE_PAIR_BOARD, copyBoard } from '../../fixtures/boards';
import {
  RELIC_CATALOGUE,
  RelicRegistry,
} from '../../../src/relics/relic-registry';
import {
  MAX_REWARD_OFFERS,
  RunController,
  resolveRunIdentity,
  type RelicRegistryPort,
} from '../../../src/run/run-controller';
import type {
  PersistedRelic,
  RewardDrawnReport,
  RunFaultReport,
  RunReporter,
  RunState,
} from '../../../src/run/run-state';
import { RUN_FAULT_OPERATIONS } from '../../../src/run/run-state';
import { RunStateStore } from '../../../src/run/run-state-store';
import { LocalStorageManager } from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import { RUN_STATE_KEY } from '../../../src/storage/storage-keys';

/** The offer every case below presents, in catalogue order. */
const OFFER: readonly string[] = ['temporal-anchor', 'tumbler', 'echo-chamber'];

/** A catalogue relic the offer never carries. */
const UNOFFERED_ID = 'culling-blade';

/** An identifier no catalogue carries. */
const UNKNOWN_ID = 'not-a-relic';

/** A relic bound to `onBeforeMove`, so one move proves it fires. */
const BEFORE_MOVE_ID = 'tumbler';

/** The seed every composition below plays under. */
const SEED = 'reward-resolution-seed';

interface Composed {
  readonly backing: MemoryStorage;
  readonly controller: RunController;
  readonly registry: RelicRegistry;
  readonly bus: HookBus;
  readonly engine: Engine;
  readonly rewards: RewardDrawnReport[];
  readonly stop: () => void;
}

interface ComposeOptions {
  /** Replaces the port the controller is handed, for the refusal cases. */
  readonly port?: (registry: RelicRegistry) => RelicRegistryPort;
}

/**
 * Composes storage, store, controller, registry, bus and engine in the order
 * src/main.ts composes them, with the registry's run port handed to the
 * controller and the same bus handed to the engine.
 */
function compose(options: ComposeOptions = {}): Composed {
  const backing = new MemoryStorage();
  const manager = new LocalStorageManager({ storage: backing });
  const config: RulesConfig = createDefaultRulesConfig();
  const stages: StageConfig = createDefaultStageConfig();
  const rewards: RewardDrawnReport[] = [];
  const reporter: RunReporter = {
    onRewardDrawn(report): void {
      rewards.push(report);
    },
  };

  const bus = createHookBus({ correlationId: SEED });
  const registry = new RelicRegistry({ bus, correlationId: SEED });
  const identity = resolveRunIdentity({ storage: manager, seed: SEED });
  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config }),
    identity,
    config,
    stages,
    reporter,
    relics: options.port === undefined
      ? registry.runPort()
      : options.port(registry),
  });

  controller.begin();

  const streams = createRngStreams(controller.seed(), controller.cursors());
  const engine = new Engine({
    config,
    streams,
    storage: manager,
    hooks: bus,
    stageContext: () => controller.stageContext(),
    relicContext: () => controller.relicContext(),
  });
  const stop = controller.observe(engine, () => streams.snapshotCursors());

  engine.setup();

  return { backing, controller, registry, bus, engine, rewards, stop };
}

/** The identifiers registered on the bus, in pickup order. */
function registeredIds(bus: HookBus): readonly string[] {
  return bus.subscribers().map((subscriber): string => subscriber.id);
}

/** The envelope as it is actually stored, or `null` when none is. */
function readStored(backing: MemoryStorage): RunState | null {
  const raw = backing.getItem(RUN_STATE_KEY) ?? null;

  return raw === null ? null : (JSON.parse(raw) as RunState);
}

/** The relic identifiers the stored envelope carries, in pickup order. */
function storedIds(backing: MemoryStorage): readonly string[] {
  const stored = readStored(backing);

  return stored === null
    ? []
    : stored.relics.map((relic: PersistedRelic): string => relic.id);
}

/** A move sequence long enough to reach a board change under any seed. */
const MOVES: readonly Direction[] = [
  DIRECTION_UP,
  DIRECTION_LEFT,
  DIRECTION_DOWN,
  DIRECTION_RIGHT,
];

function play(engine: Engine, moves: readonly Direction[] = MOVES): void {
  for (const direction of moves) {
    engine.move(direction);
  }
}

describe('recordRewardOffer admits only the offer a seeded draw makes', () => {
  it('records a bounded set of distinct catalogue identifiers', () => {
    const { controller } = compose();

    expect(controller.recordRewardOffer(OFFER)).toBe(true);
    expect(controller.resolveReward(OFFER[0]).accepted).toBe(true);
  });

  it('refuses an offer carrying an identifier no catalogue holds', () => {
    const { controller, rewards } = compose();

    expect(controller.recordRewardOffer([OFFER[0], UNKNOWN_ID])).toBe(false);

    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
    expect(controller.relics()).toEqual([]);
    expect(rewards[0].refusal).toBe('offer');
    expect(rewards[0].accepted).toBe(false);
  });

  it('refuses an offer repeating one identifier', () => {
    const { controller } = compose();

    expect(controller.recordRewardOffer([OFFER[0], OFFER[0]])).toBe(false);
    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
  });

  it('refuses an offer carrying an empty identifier', () => {
    const { controller } = compose();

    expect(controller.recordRewardOffer([OFFER[0], ''])).toBe(false);
    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
  });

  it('refuses an offer carrying a value that is not a string', () => {
    const { controller } = compose();
    const hostile = [OFFER[0], 42] as unknown as readonly string[];

    expect(controller.recordRewardOffer(hostile)).toBe(false);
    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
  });

  it('refuses an offer longer than MAX_REWARD_OFFERS', () => {
    const { controller } = compose();
    const oversized = RELIC_CATALOGUE.map((relic): string => relic.id);

    expect(oversized.length).toBeGreaterThan(MAX_REWARD_OFFERS);
    expect(controller.recordRewardOffer(oversized)).toBe(false);
    expect(controller.resolveReward(oversized[0]).accepted).toBe(false);
    expect(controller.relics()).toEqual([]);
  });

  it('refuses a value that is not an array at all', () => {
    const { controller } = compose();

    expect(
      controller.recordRewardOffer(
        'temporal-anchor' as unknown as readonly string[],
      ),
    ).toBe(false);
    expect(
      controller.recordRewardOffer(null as unknown as readonly string[]),
    ).toBe(false);
  });

  it('refuses an offer list that raises while it is read', () => {
    const { controller } = compose();
    const hostile = new Proxy([OFFER[0]], {
      get(target: string[], name: string | symbol): unknown {
        if (name === Symbol.iterator) {
          throw new Error('iteration refused');
        }

        return Reflect.get(target, name);
      },
    });

    expect(() => controller.recordRewardOffer(hostile)).not.toThrow();
    expect(controller.recordRewardOffer(hostile)).toBe(false);
    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
  });

  it('accepts an empty offer, from which nothing can be chosen', () => {
    const { controller } = compose();

    expect(controller.recordRewardOffer([])).toBe(true);
    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
    expect(controller.relics()).toEqual([]);
  });

  it('replaces the offer standing rather than accumulating offers', () => {
    const { controller } = compose();

    controller.recordRewardOffer([OFFER[0]]);
    controller.recordRewardOffer([OFFER[1]]);

    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
    expect(controller.resolveReward(OFFER[1]).accepted).toBe(true);
  });
});

describe('resolveReward admits only what was offered', () => {
  it('refuses a catalogue relic that was not in the offer', () => {
    const { controller, registry, rewards } = compose();

    controller.recordRewardOffer(OFFER);

    expect(controller.resolveReward(UNOFFERED_ID).accepted).toBe(false);
    expect(controller.relics()).toEqual([]);
    expect(registry.has(UNOFFERED_ID)).toBe(false);
    expect(rewards.at(-1)?.refusal).toBe('not-offered');
  });

  it('refuses an identifier no catalogue holds', () => {
    const { controller, rewards } = compose();

    controller.recordRewardOffer(OFFER);

    expect(controller.resolveReward(UNKNOWN_ID).accepted).toBe(false);
    expect(controller.relics()).toEqual([]);
    expect(rewards.at(-1)?.refusal).toBe('not-offered');
  });

  it('refuses an empty and a non-string selection', () => {
    const { controller } = compose();

    controller.recordRewardOffer(OFFER);

    expect(controller.resolveReward('').accepted).toBe(false);
    expect(
      controller.resolveReward(undefined as unknown as string).accepted,
    ).toBe(false);
    expect(controller.resolveReward(7 as unknown as string).accepted).toBe(
      false,
    );
    expect(controller.relics()).toEqual([]);
  });

  it('keeps a valid offer standing after a refusal', () => {
    const { controller } = compose();

    controller.recordRewardOffer(OFFER);

    expect(controller.resolveReward(UNOFFERED_ID).accepted).toBe(false);
    expect(controller.resolveReward(UNKNOWN_ID).accepted).toBe(false);

    // The screen can still be answered: the refusals did not consume the
    // offer.
    expect(controller.resolveReward(OFFER[1]).accepted).toBe(true);
    expect(controller.relics().map((relic) => relic.id)).toEqual([OFFER[1]]);
  });

  it('clears the offer once a selection is taken on', () => {
    const { controller, rewards } = compose();

    controller.recordRewardOffer(OFFER);

    expect(controller.resolveReward(OFFER[0]).accepted).toBe(true);
    expect(rewards.at(-1)?.accepted).toBe(true);
    expect(rewards.at(-1)?.refusal).toBeUndefined();

    // A second pick from a spent offer is refused: one offer, one relic.
    expect(controller.resolveReward(OFFER[1]).accepted).toBe(false);
    expect(controller.relics().map((relic) => relic.id)).toEqual([OFFER[0]]);
  });

  it('refuses a relic the run already holds', () => {
    const { controller, rewards } = compose();

    controller.recordRewardOffer(OFFER);
    controller.resolveReward(OFFER[0]);
    controller.recordRewardOffer(OFFER);

    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
    expect(rewards.at(-1)?.refusal).toBe('held');
    expect(controller.relics()).toHaveLength(1);
  });
});

describe('a resolved reward is live from the next hook onwards', () => {
  it('registers the relic with the hook bus as it is resolved', () => {
    const { controller, registry, bus } = compose();

    controller.recordRewardOffer(OFFER);

    expect(registeredIds(bus)).toEqual([]);
    expect(controller.resolveReward(BEFORE_MOVE_ID).accepted).toBe(true);
    expect(registeredIds(bus)).toEqual([BEFORE_MOVE_ID]);
    expect(registry.has(BEFORE_MOVE_ID)).toBe(true);
    expect(bus.subscriptions('onBeforeMove')).toHaveLength(1);
  });

  it('fires the relic on the very next move', () => {
    const { controller, engine, bus } = compose();

    controller.recordRewardOffer(OFFER);
    controller.resolveReward(BEFORE_MOVE_ID);

    const before = bus.metrics().totals.invoked;

    engine.move(DIRECTION_UP);

    expect(bus.metrics().totals.invoked).toBeGreaterThan(before);
    expect(
      bus
        .metrics()
        .subscribers.find((row) => row.id === BEFORE_MOVE_ID)?.invoked,
    ).toBeGreaterThan(0);
  });

  it('survives the next commit rather than being erased by its projection', () => {
    const { controller, engine, backing } = compose();

    controller.recordRewardOffer(OFFER);
    controller.resolveReward(BEFORE_MOVE_ID);

    play(engine);

    expect(controller.relics().map((relic) => relic.id)).toEqual([
      BEFORE_MOVE_ID,
    ]);
    expect(storedIds(backing)).toEqual([BEFORE_MOVE_ID]);
  });

  it('persists the relic under the run key and carries its charges', () => {
    const { controller, engine, backing } = compose();

    controller.recordRewardOffer(OFFER);
    controller.resolveReward('temporal-anchor');

    play(engine, [DIRECTION_UP]);

    const stored = readStored(backing);

    expect(stored?.relics).toHaveLength(1);
    expect(stored?.relics[0].id).toBe('temporal-anchor');
    expect(stored?.relics[0].charges).toBe(3);
  });

  it('carries a charge its handler spent into the persisted envelope', () => {
    const { controller, engine, backing, bus } = compose();

    controller.recordRewardOffer(['frostbind', OFFER[1], OFFER[2]]);

    expect(controller.resolveReward('frostbind').accepted).toBe(true);

    // A board with one merge pair, so the very next move resolves exactly one
    // merge — which is the effect `frostbind` spends a charge on.
    engine.setup(copyBoard(MERGE_PAIR_BOARD));
    engine.move(DIRECTION_LEFT);

    const spent = bus
      .subscribers()
      .find((subscriber) => subscriber.id === 'frostbind')?.charges;
    const stored = readStored(backing);

    expect(spent).toBe(7);
    expect(stored?.relics[0].id).toBe('frostbind');
    expect(stored?.relics[0].charges).toBe(7);
  });

  it('keeps pickup order across two rewards, in the commit context too', () => {
    const { controller, engine, bus } = compose();

    controller.recordRewardOffer(OFFER);
    controller.resolveReward(OFFER[2]);
    controller.recordRewardOffer(OFFER);
    controller.resolveReward(OFFER[0]);

    play(engine, [DIRECTION_UP]);

    expect(controller.relics().map((relic) => relic.id)).toEqual([
      OFFER[2],
      OFFER[0],
    ]);
    expect(registeredIds(bus)).toEqual([OFFER[2], OFFER[0]]);
    expect(controller.relicContext().map((entry) => entry.id)).toEqual([
      OFFER[2],
      OFFER[0],
    ]);
  });

  it('restores a stored reward into the live registry on the next load', () => {
    const first = compose();

    first.controller.recordRewardOffer(OFFER);
    first.controller.resolveReward('temporal-anchor');
    play(first.engine, [DIRECTION_UP]);
    first.stop();

    // A second composition over the same storage, as a reload composes.
    const manager = new LocalStorageManager({ storage: first.backing });
    const config = createDefaultRulesConfig();
    const bus = createHookBus({ correlationId: SEED });
    const registry = new RelicRegistry({ bus, correlationId: SEED });
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager }),
      config,
      relics: registry.runPort(),
    });

    controller.begin();

    expect(controller.relics().map((relic) => relic.id)).toEqual([
      'temporal-anchor',
    ]);
    expect(registeredIds(bus)).toEqual(['temporal-anchor']);
    expect(registry.find('temporal-anchor')?.charges).toBe(3);
  });
});

describe('resolveReward reports success only where the registry agrees', () => {
  it('appends nothing when the registry refuses the pickup', () => {
    const { controller, rewards } = compose({
      port: (registry) => ({
        ...registry.runPort(),
        pickUpRelic: (): PersistedRelic | null => null,
      }),
    });

    controller.recordRewardOffer(OFFER);

    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
    expect(controller.relics()).toEqual([]);
    expect(rewards.at(-1)?.refusal).toBe('refused');

    // The offer still stands, so the screen can be answered again.
    expect(controller.resolveReward(OFFER[1]).accepted).toBe(false);
  });

  it('withdraws the append when the registry does not report holding it', () => {
    const { controller, rewards } = compose({
      port: (registry) => ({
        ...registry.runPort(),
        holdsRelic: (): boolean => false,
      }),
    });

    controller.recordRewardOffer(OFFER);

    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
    expect(controller.relics()).toEqual([]);
    expect(rewards.at(-1)?.refusal).toBe('unconfirmed');
  });

  it('refuses the selection when the pickup throws, and reports it', () => {
    const faults: RunFaultReport[] = [];
    const backing = new MemoryStorage();
    const manager = new LocalStorageManager({ storage: backing });
    const config = createDefaultRulesConfig();
    const registry = new RelicRegistry({ correlationId: SEED });
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager, seed: SEED }),
      config,
      reporter: {
        // The fault channel. A registry that threw wrote nothing, so
        // the report names the operation rather than a run-state write.
        // DL-RUN-10.
        onRunFaulted(report): void {
          faults.push(report);
        },
      },
      relics: {
        ...registry.runPort(),
        pickUpRelic: (): PersistedRelic | null => {
          throw new Error('registry refused');
        },
      },
    });

    controller.begin();
    controller.recordRewardOffer(OFFER);

    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
    expect(controller.relics()).toEqual([]);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toMatchObject({
      operation: RUN_FAULT_OPERATIONS.relicPickup,
      affectsRunFlow: true,
    });
  });

  it('refuses every offer when the catalogue accessor throws', () => {
    const registry = new RelicRegistry({ correlationId: SEED });
    const manager = new LocalStorageManager({ storage: new MemoryStorage() });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager, seed: SEED }),
      config,
      relics: {
        ...registry.runPort(),
        knowsRelic: (): boolean => {
          throw new Error('catalogue refused');
        },
      },
    });

    controller.begin();

    expect(controller.recordRewardOffer(OFFER)).toBe(false);
    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
    expect(controller.relics()).toEqual([]);
  });

  it('admits an offer on shape alone when no registry is attached', () => {
    const manager = new LocalStorageManager({ storage: new MemoryStorage() });
    const config = createDefaultRulesConfig();
    const controller = new RunController({
      store: new RunStateStore({ storage: manager, config }),
      identity: resolveRunIdentity({ storage: manager, seed: SEED }),
      config,
    });

    controller.begin();

    // Without a registry there is no catalogue to consult, so the shape and
    // the offer are the whole admission — and the entry persisted is the bare
    // identifier, which is what a relic carrying neither charges nor state is.
    expect(controller.recordRewardOffer(OFFER)).toBe(true);
    expect(controller.resolveReward(OFFER[0]).accepted).toBe(true);
    expect(controller.relics()).toEqual([{ id: OFFER[0] }]);
    expect(controller.resolveReward(UNKNOWN_ID).accepted).toBe(false);
  });

  it('drops the offer a finished run was presenting', () => {
    const { controller, engine } = compose();

    controller.recordRewardOffer(OFFER);
    controller.endRun('abandoned');

    expect(controller.resolveReward(OFFER[0]).accepted).toBe(false);
    expect(controller.relics()).toEqual([]);
    expect(engine.isGameTerminated()).toBe(false);
  });
});
