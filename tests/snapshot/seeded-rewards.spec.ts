// Seeded reward snapshots: the draw sequence an offer is made from, and the
// offers the production path actually makes.
//
// AAP V2 requires one seed to yield identical relic offers, not merely an
// identical board. Two layers are recorded here:
//
//   sections 1-4  the raw substream values, the rarity table and tier order of
//                 src/relics/relic-types.ts, and the shrinking-pool indices a
//                 rarity-weighted 1-of-3 draw without replacement consumes — one
//                 weighted tier draw per slot, then one index draw per slot
//                 against a pool of 16, 15, 14. No relic identifier is recorded
//                 in these four sections.
//   section 5     the offers themselves, drawn by composing what src/main.ts
//                 composes: `RunController` over a `RunStateStore`, a
//                 `RelicRegistry` over `RELIC_CATALOGUE` and the shared hook
//                 bus, `drawRelicOffers` as the draw port, and a real `Engine`.
//                 Every card offered at every stage is recorded by identifier,
//                 rarity, charge budget and bound hooks, along with which relic
//                 was taken, the relics held in pickup order, the run summary and
//                 the board and cursors the run ended on.
//
// The two spawn substreams are separate from the two relic substreams, so a
// reward draw cannot move the board's sequence. That is asserted here from the
// draw side and in tests/snapshot/seeded-boards.spec.ts from the board side.
//
//   Section 4 closes the other half of AAP V2's second requirement without
//   breaking that property. A drawn offer is only reproducible if a caller can
//   turn it into the same relic twice, so those cases drive the SHIPPED draw and
//   the SHIPPED reward transition — `drawRelicOffers`, `RunController` and
//   `RelicRegistry.runPort` — twice from one seed and compare the two runs WITH
//   EACH OTHER rather than against a recorded identifier.
//
//   What it does instead is pin the sequence of draws a rarity-weighted 1-of-3
//   selection without replacement consumes, at exactly the call sites such a
//   selection makes: one weighted tier draw per offered slot, then one index
//   draw per slot against a pool shrinking 16, 15, 14. When the draw module
//   lands, its offers are a pure function of these recorded values and the
//   catalogue order — so a change to the PRNG, to the substream derivation, to
//   `pickWeighted`'s walk or to the tier weights breaks a snapshot here and is
//   caught before it can silently make every recorded run's offers different.
//
// Decision DL-RNG-04 governs that substream separation. The remaining
// decisions behind this file are recorded in docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../src/config/default-config';
import { createHookBus } from '../../src/engine/hook-bus';
import {
  RNG_STREAM_NAMES,
  createRngStreams,
  type RngStreams,
  type StreamName,
} from '../../src/rng/rng-streams';
import { drawRelicOffers } from '../../src/relics/relic-draw';
import { RelicRegistry } from '../../src/relics/relic-registry';
import {
  DEFAULT_RARITY_WEIGHTS,
  RARITIES,
  RELIC_FAMILY_NAMES,
  type Rarity,
} from '../../src/relics/relic-types';
import { RunController, resolveRunIdentity } from '../../src/run/run-controller';
import { RunStateStore } from '../../src/run/run-state-store';
import { LocalStorageManager } from '../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../src/storage/memory-storage';
import {
  formatBoard,
  formatCursors,
  formatDraws,
  formatPicks,
} from '../fixtures/snapshot-format';
import { PLATFORM_MATH_RANDOM } from '../fixtures/math-random-reference';
import { createDefaultStageConfig } from '../../src/config/stage-config';
import { Engine } from '../../src/engine/engine';
import { HOOK_NAMES } from '../../src/engine/hooks';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  type Direction,
  type SerializedGameState,
} from '../../src/engine/types';
import { RELIC_CATALOGUE } from '../../src/relics/relic-registry';
import type { RewardOffer } from '../../src/run/run-controller';
import type { RunSummary } from '../../src/run/run-state';
import type { RngCursorMap } from '../../src/rng/rng-streams';

/** The four directions, cycled by the production-path run below. */
const PRODUCTION_MOVE_CYCLE: readonly Direction[] = [
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
];

/* ==========================================================================
 * Harness
 * ========================================================================== */

/** Slots one reward offer holds, per AAP R8: choose 1 of 3. */
const OFFER_SLOTS = 3;

/** Relics the pool holds, per AAP A1: exactly sixteen, four per family. */
const POOL_SIZE = 16;

/** Seeds every case below is recorded at. */
const SEEDS: readonly string[] = [
  'reward-seed-alpha',
  'reward-seed-bravo',
  'reward-seed-charlie',
];

/** The rarity weights in tier order, as `pickWeighted` takes them. */
const RARITY_WEIGHTS: readonly number[] = RARITIES.map(
  (rarity) => DEFAULT_RARITY_WEIGHTS[rarity],
);

/** Draws `count` raw values from one named substream. */
function drawRaw(
  streams: RngStreams,
  name: StreamName,
  count: number,
): number[] {
  const stream = streams.stream(name);
  const drawn: number[] = [];

  for (let index = 0; index < count; index += 1) {
    drawn.push(stream.next());
  }

  return drawn;
}

/**
 * Draws the rarity tier of each of the three offered slots.
 *
 * `pickWeighted` is the shipped selection: one draw per call, scaled by the
 * total of the weights, then the weights walked in index order until the running
 * total exceeds it. The weights are the shipped table, halving per tier.
 */
function drawTiers(streams: RngStreams): (Rarity | undefined)[] {
  const stream = streams.stream('rarity-weight');
  const tiers: (Rarity | undefined)[] = [];

  for (let slot = 0; slot < OFFER_SLOTS; slot += 1) {
    tiers.push(stream.pickWeighted(RARITIES, RARITY_WEIGHTS));
  }

  return tiers;
}

/**
 * Draws the pool index of each of the three offered slots, WITHOUT REPLACEMENT.
 *
 * The pool shrinks by one per slot — 16, 15, 14 — which is the mechanism that
 * makes a duplicate in one offer structurally impossible rather than filtered
 * out afterwards. Indices rather than identifiers are recorded here so a
 * reordered catalogue cannot invalidate a recorded sequence; section 5 records
 * the identifiers the shipped draw resolves them to.
 */
function drawPoolIndices(streams: RngStreams): number[] {
  const stream = streams.stream('relic-draw');
  const indices: number[] = [];

  for (let slot = 0; slot < OFFER_SLOTS; slot += 1) {
    indices.push(stream.nextInt(POOL_SIZE - slot));
  }

  return indices;
}

/**
 * Resolves three distinct pool positions from three shrinking-pool indices.
 *
 * The reduction a draw without replacement performs: each index selects from
 * what remains, and the selected entry is removed. Recorded so the mapping from
 * the drawn indices to distinct positions is itself pinned, and so the
 * no-duplicate property is visible in the stored artifact rather than only
 * asserted.
 */
function resolveDistinct(indices: readonly number[]): number[] {
  const remaining: number[] = [];

  for (let position = 0; position < POOL_SIZE; position += 1) {
    remaining.push(position);
  }

  return indices.map((index) => remaining.splice(index, 1)[0] ?? -1);
}

/* ==========================================================================
 * 1. The raw substream sequences
 * ========================================================================== */

describe('the relic substreams', () => {
  it.each(SEEDS)('reproduces its recorded relic-draw sequence for "%s"', (seed) => {
    expect(
      formatDraws(drawRaw(createRngStreams(seed), 'relic-draw', 12)),
    ).toMatchSnapshot();
  });

  it.each(SEEDS)(
    'reproduces its recorded rarity-weight sequence for "%s"',
    (seed) => {
      expect(
        formatDraws(drawRaw(createRngStreams(seed), 'rarity-weight', 12)),
      ).toMatchSnapshot();
    },
  );

  it('gives every substream of one seed a different sequence', () => {
    const streams = createRngStreams('substream-derivation');
    const first: Record<string, number> = {};

    for (const name of RNG_STREAM_NAMES) {
      first[name] = streams.stream(name).next();
    }

    // Each substream is seeded with `deriveStreamSeed(seed, name)`, so four
    // substreams of one seed are four sequences rather than one sequence read
    // four times. Were they equal, a relic draw and a spawn would move together.
    expect(new Set(Object.values(first)).size).toBe(RNG_STREAM_NAMES.length);
  });
});

/* ==========================================================================
 * 2. The offer draw
 * ========================================================================== */

describe('a reward offer drawn from a fixed seed', () => {
  it.each(SEEDS)('reproduces its recorded three tiers for "%s"', (seed) => {
    expect(formatPicks(drawTiers(createRngStreams(seed)))).toMatchSnapshot();
  });

  it.each(SEEDS)(
    'reproduces its recorded three pool positions for "%s"',
    (seed) => {
      const indices = drawPoolIndices(createRngStreams(seed));

      expect(
        [
          'drawn indices (pool shrinking 16, 15, 14)',
          formatDraws(indices),
          'resolved pool positions',
          formatDraws(resolveDistinct(indices)),
        ].join('\n'),
      ).toMatchSnapshot();
    },
  );

  it.each(SEEDS)('offers three distinct pool positions for "%s"', (seed) => {
    const positions = resolveDistinct(drawPoolIndices(createRngStreams(seed)));

    // No duplicate in one set of three, and not by filtering afterwards: the
    // pool a slot draws from no longer holds what the previous slot took.
    expect(new Set(positions).size).toBe(OFFER_SLOTS);
    expect(positions.every((position) => position >= 0 && position < POOL_SIZE)).toBe(
      true,
    );
  });

  it('reproduces its recorded offers across many consecutive draws', () => {
    // Twelve consecutive offers from one seed, which is more stages than a run
    // is likely to reach. Recorded as one artifact so a change in the sequence
    // shows up wherever in the run it occurs, not only on the first offer.
    const streams = createRngStreams('reward-sequence-long');
    const rendered: string[] = [];

    for (let offer = 0; offer < 12; offer += 1) {
      const tiers = drawTiers(streams);
      const positions = resolveDistinct(drawPoolIndices(streams));

      rendered.push(
        `offer ${String(offer + 1).padStart(2)}  tiers ${tiers.join(', ')}  ` +
          `positions ${positions.join(', ')}`,
      );
    }

    expect(
      [rendered.join('\n'), 'rngCursor', formatCursors(streams.snapshotCursors())].join(
        '\n',
      ),
    ).toMatchSnapshot();
  });
});

/* ==========================================================================
 * 3. Independence — what protects every other snapshot in this suite
 * ========================================================================== */

describe('drawing rewards', () => {
  it('leaves the two spawn substreams untouched', () => {
    const streams = createRngStreams('reward-independence');

    for (let offer = 0; offer < 8; offer += 1) {
      drawTiers(streams);
      drawPoolIndices(streams);
    }

    const cursors = streams.snapshotCursors();

    // Forty-eight relic draws, and the board's sequence has not moved. This is
    // the property that lets the relic system be added without invalidating a
    // single recorded board in tests/snapshot/seeded-boards.spec.ts.
    expect(cursors['spawn-value']).toBe(0);
    expect(cursors['spawn-position']).toBe(0);
    expect(cursors['rarity-weight']).toBe(24);
    expect(cursors['relic-draw']).toBe(24);
  });

  it('yields the same offers whether or not the board has been played', () => {
    const untouched = createRngStreams('reward-order-independence');
    const played = createRngStreams('reward-order-independence');

    // A board's worth of spawn draws taken first.
    for (let turn = 0; turn < 20; turn += 1) {
      played.stream('spawn-value').next();
      played.stream('spawn-position').next();
    }

    const before = formatPicks(drawTiers(untouched));
    const after = formatPicks(drawTiers(played));

    expect(after).toBe(before);
  });

  it('never replaces Math.random', () => {
    const streams = createRngStreams('reward-math-random-guard');

    drawTiers(streams);
    drawPoolIndices(streams);

    expect(Math.random).toBe(PLATFORM_MATH_RANDOM);
  });
});

/* ==========================================================================
 * 4. One seed, one admitted relic
 * ========================================================================== */

// The draw is only half of AAP V2's second requirement: an offer that no caller
// can turn into the same relic twice is not a reproducible run. The two cases
// below therefore drive the SHIPPED draw and the SHIPPED reward transition —
// `drawRelicOffers`, `RunController.recordRewardOffer`/`resolveReward` and
// `RelicRegistry.runPort` — twice from one seed and compare the two outcomes
// with each other.
//
// NO IDENTIFIER IS RECORDED IN A SNAPSHOT HERE EITHER. The comparison is
// between the two runs, so adding, removing or reordering a relic cannot
// invalidate a stored artifact, exactly as in the sections above.

/** Runs one seeded offer and selection, and reports what it admitted. */
function admitOneReward(seed: string): {
  readonly offered: readonly string[];
  readonly accepted: boolean;
  readonly held: readonly string[];
  readonly registered: readonly string[];
} {
  const streams = createRngStreams(seed);
  const registry = new RelicRegistry({
    bus: createHookBus({ correlationId: seed }),
  });
  const config = createDefaultRulesConfig();
  const manager = new LocalStorageManager({ storage: new MemoryStorage() });
  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config }),
    identity: resolveRunIdentity({ storage: manager, seed }),
    config,
    relics: registry.runPort(),
  });

  controller.begin();

  const offers = drawRelicOffers({
    pool: registry.catalogue(),
    ownedIds: registry.ownedIds(),
    streams,
    count: OFFER_SLOTS,
  });
  const offered = offers.map((relic) => relic.id);

  controller.recordRewardOffer(offered);

  // The first slot is chosen every time, so the only thing that can differ
  // between two runs of one seed is the draw and the admission.
  const accepted = controller.resolveReward(offered[0] ?? '').accepted;

  return {
    offered,
    accepted,
    held: controller.relics().map((relic) => relic.id),
    registered: registry.ownedIds(),
  };
}

describe('admitting a drawn reward', () => {
  it.each(SEEDS)(
    'admits the same relic from the same seed for "%s"',
    (seed) => {
      const first = admitOneReward(seed);
      const second = admitOneReward(seed);

      expect(first.offered).toHaveLength(OFFER_SLOTS);
      expect(new Set(first.offered).size).toBe(OFFER_SLOTS);
      expect(second.offered).toEqual(first.offered);
      expect(second.held).toEqual(first.held);
      expect(first.accepted).toBe(true);
      expect(second.accepted).toBe(true);
    },
  );

  it.each(SEEDS)(
    'registers exactly the admitted relic live for "%s"',
    (seed) => {
      const run = admitOneReward(seed);

      // The persisted list and the live registrations are one list: a relic that
      // was admitted but not registered would fire on no hook.
      expect(run.held).toEqual([run.offered[0]]);
      expect(run.registered).toEqual(run.held);
    },
  );

  it('refuses an unoffered relic under every recorded seed', () => {
    for (const seed of SEEDS) {
      const streams = createRngStreams(seed);
      const registry = new RelicRegistry({
        bus: createHookBus({ correlationId: seed }),
      });
      const config = createDefaultRulesConfig();
      const manager = new LocalStorageManager({ storage: new MemoryStorage() });
      const controller = new RunController({
        store: new RunStateStore({ storage: manager, config }),
        identity: resolveRunIdentity({ storage: manager, seed }),
        config,
        relics: registry.runPort(),
      });

      controller.begin();

      const offered = drawRelicOffers({
        pool: registry.catalogue(),
        ownedIds: registry.ownedIds(),
        streams,
        count: OFFER_SLOTS,
      }).map((relic) => relic.id);
      const unoffered = registry
        .catalogue()
        .map((relic) => relic.id)
        .find((id) => !offered.includes(id));

      controller.recordRewardOffer(offered);

      expect(unoffered).toBeDefined();
      expect(controller.resolveReward(unoffered ?? '').accepted).toBe(false);
      expect(controller.relics()).toEqual([]);
      expect(registry.ownedIds()).toEqual([]);
    }
  });
});

/* ==========================================================================
 * 5. The shipped catalogue constants the draw reads
 * ========================================================================== */

describe('the draw tables', () => {
  it('reproduces its recorded rarity tiers and weights', () => {
    // Recorded because an offer is a function of these as much as of the seed: a
    // reordered tier list or a reweighted tier changes every offer ever drawn,
    // and this is the artifact that says so out loud.
    expect(
      RARITIES.map(
        (rarity) => `${rarity.padEnd(12)}${String(DEFAULT_RARITY_WEIGHTS[rarity])}`,
      ).join('\n'),
    ).toMatchSnapshot();
  });

  it('reproduces its recorded family order', () => {
    expect(RELIC_FAMILY_NAMES.join('\n')).toMatchSnapshot();
  });

  it('weights each tier at half the tier before it', () => {
    for (let index = 1; index < RARITIES.length; index += 1) {
      const previous = DEFAULT_RARITY_WEIGHTS[RARITIES[index - 1] as Rarity];
      const current = DEFAULT_RARITY_WEIGHTS[RARITIES[index] as Rarity];

      expect(current * 2).toBe(previous);
    }
  });
});

/* ==========================================================================
 * 5. The offer as the production path actually draws it
 * ==========================================================================
 *
 * Sections 1 to 4 record the DRAW SEQUENCE — the substream values, the tiers and
 * the shrinking-pool indices a rarity-weighted 1-of-3 selection consumes. They
 * were written before src/relics/relic-draw.ts and src/run/run-controller.ts's
 * reward transaction existed, and they hold no relic identifier, so on their own
 * they stay green whether or not a reward ever reaches a run.
 *
 * This section closes that gap by composing the same objects src/main.ts
 * composes — `RunController` over a `RunStateStore`, a `RelicRegistry` over
 * `RELIC_CATALOGUE` and the shared hook bus, `drawRelicOffers` as the draw port,
 * and a real `Engine` — playing a fixed move list, and recording the OFFERS
 * THEMSELVES: the identifier, rarity and charge budget of every card offered at
 * every stage, which relic was taken, and the board and cursors that state was
 * reached with.
 *
 * A break here therefore means one of: the seed no longer produces the same
 * offers, the reward no longer reaches the run at all, the draw stopped
 * excluding relics the run already holds, or the pickup order changed. None of
 * those is visible to sections 1 to 4.
 */

/** Stage 1's goal is a 16 tile, so a list this long clears several stages. */
const RUN_MOVES: readonly Direction[] = Array.from(
  { length: 160 },
  (_value, index): Direction => PRODUCTION_MOVE_CYCLE[index % 4] as Direction,
);

/** One offer as it is recorded: what was on the cards, and what was taken. */
interface OfferRecord {
  readonly stageIndex: number;
  readonly cards: readonly RewardOffer[];
  readonly taken: string;
}

/**
 * Plays one seeded run through the production reward path.
 *
 * @param seed Seed the run is played under.
 * @returns Every offer made, the relics held afterwards, and the final state.
 */
function playProductionRun(seed: string): {
  readonly offers: readonly OfferRecord[];
  readonly owned: readonly string[];
  readonly board: SerializedGameState;
  readonly cursors: RngCursorMap;
  readonly stageIndex: number;
  readonly summary: RunSummary | null;
  readonly movesPlayed: number;
} {
  const backing = new MemoryStorage();
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const stages = createDefaultStageConfig();
  const tokens = [seed, 'reward-run-instance'];

  let nextToken = 0;
  const createToken = (): string =>
    tokens[nextToken++] ?? `token-${String(nextToken)}`;

  const identity = resolveRunIdentity({ storage: manager, createToken });
  const hooks = createHookBus();
  const registry = new RelicRegistry({ catalogue: RELIC_CATALOGUE, bus: hooks });

  let streams: RngStreams | null = null;

  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config }),
    identity,
    config,
    stages,
    createToken,

    // The same two ports src/main.ts injects, delegating on every call rather
    // than capturing, so a charge spent and a state slot advanced are read at
    // write time.
    relics: {
      snapshotRelics: () => registry.serialize(),
      activateRelic: (relicId) => {
        const taken = registry.pickUp(relicId);

        if (taken === undefined) {
          return null;
        }

        return registry.serialize().find((entry) => entry.id === relicId) ?? null;
      },
      ownedRelicIds: () => registry.ownedIds(),
      restoreRelics: (relics) => {
        registry.restore(relics);
      },
      resolveRelic: (relicId) => {
        const known = registry
          .catalogue()
          .find((relic) => relic.id === relicId);

        return known === undefined
          ? null
          : Object.freeze({
              id: known.id,
              ...(known.charges === undefined ? {} : { charges: known.charges }),
            });
      },
    },
    rewards: {
      draw: ({ count, ownedIds }) =>
        streams === null
          ? []
          : drawRelicOffers({
              pool: registry.catalogue(),
              ownedIds,
              count,
              streams,
            }).map(
              (relic): RewardOffer =>
                Object.freeze({
                  id: relic.id,
                  name: relic.name,
                  rarity: relic.rarity,
                  description: relic.description,
                  hooks: Object.freeze(
                    HOOK_NAMES.filter(
                      (name) => relic.hooks[name] !== undefined,
                    ),
                  ),
                  ...(relic.charges === undefined
                    ? {}
                    : { charges: relic.charges }),
                }),
            ),
    },
  });

  controller.begin();
  streams = createRngStreams(controller.seed(), controller.cursors());

  const engine = new Engine({
    config,
    streams,
    storage: manager,
    hooks,
    stageContext: () => controller.stageContext(),
    relicContext: () => controller.relicContext(),
  });

  const stop = controller.observe(engine, () => streams?.snapshotCursors() ?? {});

  engine.setup();

  const offers: OfferRecord[] = [];
  let movesPlayed = 0;

  for (const direction of RUN_MOVES) {
    engine.move(direction);
    movesPlayed += 1;

    // THE RUN ENDS WITH THE BOARD. A loss finishes the run and opens a fresh
    // one, so playing on past it would record a state belonging to a run that
    // was never offered a reward.
    if (engine.serialize().over) {
      break;
    }

    if (!controller.isRewardPending()) {
      continue;
    }

    const cards = controller.currentOffer();

    // A deterministic choice that is not always the first card, so the recorded
    // sequence exercises more than one position of the offer.
    const chosen = cards[offers.length % cards.length];

    if (chosen === undefined) {
      throw new Error('a pending reward held no card');
    }

    const selection = controller.selectReward(chosen.id, engine);

    if (selection.outcome !== 'accepted') {
      throw new Error(
        `the production path refused ${chosen.id}: ${selection.outcome}`,
      );
    }

    offers.push({
      stageIndex: selection.stageIndex - 1,
      cards,
      taken: chosen.id,
    });
  }

  stop();

  const board = engine.serialize();

  return {
    offers,
    owned: registry.ownedIds(),
    board,
    cursors: streams.snapshotCursors(),

    // After a loss the controller has already opened a fresh run, so the stage
    // the PLAYED run reached is the one its summary carries.
    stageIndex: board.over
      ? (controller.lastSummary()?.stageIndex ?? controller.stageIndex())
      : controller.stageIndex(),
    summary: controller.lastSummary(),
    movesPlayed,
  };
}

/** Renders one run's offers, relics, board and cursors as one artifact. */
function renderProductionRun(
  played: ReturnType<typeof playProductionRun>,
): string {
  const lines: string[] = ['offers, in the order they were made'];

  for (const record of played.offers) {
    lines.push(
      `  stage ${String(record.stageIndex + 1)}`,
      ...record.cards.map(
        (card): string =>
          `    ${card.id === record.taken ? 'TAKEN ' : '      '}` +
          `${card.id.padEnd(18)}${card.rarity.padEnd(12)}` +
          `charges ${card.charges === undefined ? '-' : String(card.charges)}` +
          `  hooks ${card.hooks.join(', ')}`,
      ),
    );
  }

  const summary = played.summary;

  lines.push(
    '',
    `relics held, in pickup order: ${played.owned.join(', ')}`,
    `stage reached: ${String(played.stageIndex + 1)}`,
    `moves played: ${String(played.movesPlayed)}`,
    '',
    'run summary',
    summary === null
      ? '  none: the run was still in progress'
      : [
          `  seed ${summary.seed}`,
          `  score ${String(summary.score)}`,
          `  stage ${String(summary.stageIndex + 1)}`,
          `  relics ${summary.relics
            .map(
              (relic): string =>
                `${relic.id}${
                  relic.charges === undefined
                    ? ''
                    : ` (${String(relic.charges)} left)`
                }`,
            )
            .join(', ')}`,
        ].join('\n'),
    '',
    'board as played',
    formatBoard(played.board),
    '',
    'rngCursor',
    formatCursors(played.cursors),
  );

  return lines.join('\n');
}

describe('a run played through the production reward path', () => {
  it.each(SEEDS)('reproduces its recorded offers and board for "%s"', (seed) => {
    expect(renderProductionRun(playProductionRun(seed))).toMatchSnapshot();
  });

  it.each(SEEDS)('offers three distinct relics per stage for "%s"', (seed) => {
    const played = playProductionRun(seed);

    expect(played.offers.length).toBeGreaterThan(0);

    for (const record of played.offers) {
      const ids = record.cards.map((card): string => card.id);

      // No duplicate WITHIN one offer, and every card a real catalogue relic.
      expect(new Set(ids).size).toBe(ids.length);

      for (const id of ids) {
        expect(RELIC_CATALOGUE.some((relic) => relic.id === id)).toBe(true);
      }
    }
  });

  it.each(SEEDS)('never offers a relic the run already holds for "%s"', (seed) => {
    const played = playProductionRun(seed);
    const held: string[] = [];

    for (const record of played.offers) {
      for (const card of record.cards) {
        expect(held).not.toContain(card.id);
      }

      held.push(record.taken);
    }

    expect(played.owned).toEqual(held);
  });

  it.each(SEEDS)('plays the same run twice for "%s"', (seed) => {
    // The repeated-run half of AAP V2, asserted through the production path
    // rather than through a simulation of it: same seed, same move list, same
    // offers, same relics, same board.
    expect(renderProductionRun(playProductionRun(seed))).toBe(
      renderProductionRun(playProductionRun(seed)),
    );
  });

  it('draws different offers from different seeds', () => {
    const first = playProductionRun(SEEDS[0] as string);
    const second = playProductionRun(SEEDS[1] as string);

    expect(renderProductionRun(first)).not.toBe(renderProductionRun(second));
  });
});
