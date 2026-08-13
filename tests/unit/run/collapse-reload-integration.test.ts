// The board-shrink contract driven END TO END, through every collaborator that
// carries it, with nothing standing in for anything: a real `Engine` over a real
// `HookBus`, a real `RelicRegistry` over the shipped catalogue, a real
// `RunController` over a real `RunStateStore` and a real `LocalStorageManager`,
// interrupted by throwing the entire stack away and rebuilding it over the same
// storage.
//
// WHY THIS SUITE EXISTS
//   tests/unit/run/run-relic-board-size.test.ts and
//   tests/unit/run/board-size-reconciliation.test.ts both hold parts of this
//   contract, and NEITHER CONSTRUCTS AN ENGINE. They write an envelope by hand
//   that already declares a collapsed edge length, then assert that the store,
//   the registry and the controller agree about the number in it. So the two
//   steps either side of the number were untested: that a relic dispatched
//   through the hook bus ACTUALLY SHRINKS the board and records the edge length
//   it left behind, and that a reloaded engine REBUILDS at the reconciled size
//   with its tiles and its terminal-state checks intact. A regression in either
//   would leave both suites green.
//
//   The reconciliation itself has a cycle in it that only a composed run
//   exercises: the value needed to load the envelope correctly lives inside the
//   envelope, so `RunStateStore.peekRelics()` reads the stored entries with no
//   reconciliation, `RelicRegistry.relicBoardSize()` derives the edge length from
//   them generically — naming no relic, as AAP Contract 3 requires — and
//   `RunController.begin()` feeds the result back into `load()`.
//
// The prompt edge case this discharges, in full: "board-size-altering cursed
// relics (e.g. shrink board) must not corrupt existing tile positions or
// win/lose check". Every clause is asserted after a real reload: the size, the
// tiles, their positions, the loss probe and the win value.
//
// The relic is `collapsing-vault`, which the catalogue declares at `onStageEnd`;
// it is picked up through the registry's own run port rather than injected, so
// the pickup order and the charge accounting are the shipped ones.
//
// Storage is `MemoryStorage` throughout, so no case reads a document or a Web
// Storage global and one case's storage never reaches the next. Randomness is
// consumed only through the seeded substreams the controller resumes, so the
// collapse — which draws to re-home an exiled tile — is deterministic.
//
// Collected by the unit:dom-free project of vitest.config.ts, environment
// 'node'.
//
// Decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import type { RulesConfig } from '../../../src/config/rules-config';
import { createDefaultStageConfig } from '../../../src/config/stage-config';
import { Engine } from '../../../src/engine/engine';
import { createHookBus } from '../../../src/engine/hook-bus';
import { movesAvailable } from '../../../src/engine/terminal-state';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  type Direction,
  type SerializedGameState,
} from '../../../src/engine/types';
import { RELIC_CATALOGUE, RelicRegistry } from '../../../src/relics/relic-registry';
import { createRngStreams } from '../../../src/rng/rng-streams';
import type { RngStreams } from '../../../src/rng/rng-streams';
import {
  RunController,
  resolveRunIdentity,
} from '../../../src/run/run-controller';
import type { PersistedRelic } from '../../../src/run/run-state';
import { RunStateStore } from '../../../src/run/run-state-store';
import { LocalStorageManager } from '../../../src/storage/local-storage-manager';
import { MemoryStorage } from '../../../src/storage/memory-storage';

/* ===== 1. Fixtures ===== */

/** The cursed relic under test, which shrinks the board at `onStageEnd`. */
const CURSED_ID = 'collapsing-vault';

/** The default edge length a fresh run opens on. */
const OPENING_SIZE = 4;

/** Seed every run below is played under. */
const RUN_SEED = 'collapse-integration-seed';

/** Directions played, cycling all four so a stage clears. */
const MOVE_CYCLE: readonly Direction[] = Object.freeze([
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
]);

/** Moves played per leg. Long enough that a stage clears and the relic fires. */
const MOVES_PER_LEG = 30;

/* ===== 2. The composed stack ===== */

/** Every collaborator src/main.ts composes, over one storage backing. */
interface Stack {
  readonly controller: RunController;
  readonly engine: Engine;
  readonly registry: RelicRegistry;
  readonly config: RulesConfig;
  readonly streams: RngStreams;
  readonly stop: () => void;

  /**
   * The stage indices `stage:end` was emitted for, in order.
   *
   * Observed on the engine's own event source rather than counted by the cases,
   * so "the move list cleared a stage" is a MEASUREMENT of the run rather than
   * an assumption about it.
   */
  readonly stageEnds: readonly number[];

  /** The board size after each `stage:end`, in the same order. */
  readonly sizeAfterEachStageEnd: readonly number[];
}

/**
 * Composes the run controller, the relic registry, the hook bus and the engine
 * over one storage backing, exactly as the composition root does.
 *
 * The controller's relic port IS the registry — the registry satisfies
 * `RelicRegistryPort` itself — so `peekRelics`, `relicBoardSize` and
 * `restoreRelics` are the shipped implementations rather than adapters written
 * here. `begin()` runs before the generator is built, so a resumed leg continues
 * the substream positions the envelope recorded.
 *
 * @param backing Storage the envelope is written to and read from.
 * @returns The composed stack and the release for the controller's subscription.
 */
function compose(backing: MemoryStorage): Stack {
  const manager = new LocalStorageManager({ storage: backing });
  const config = createDefaultRulesConfig();
  const hooks = createHookBus({ correlationId: RUN_SEED });
  const registry = new RelicRegistry({
    catalogue: RELIC_CATALOGUE,
    bus: hooks,
  });

  const controller = new RunController({
    store: new RunStateStore({ storage: manager, config }),
    identity: resolveRunIdentity({
      storage: manager,
      createToken: (): string => RUN_SEED,
    }),
    config,
    stages: createDefaultStageConfig(),
    createToken: (): string => RUN_SEED,
    relics: registry,
  });

  controller.begin();

  const streams = createRngStreams(controller.seed(), controller.cursors());
  const engine = new Engine({
    config,
    streams,
    storage: manager,
    hooks,
    stageContext: (): ReturnType<RunController['stageContext']> =>
      controller.stageContext(),
    relicContext: (): ReturnType<RunController['relicContext']> =>
      controller.relicContext(),
  });

  const stop = controller.observe(engine, () => streams.snapshotCursors());

  // Observed BEFORE the board opens, so the first stage end is recorded too.
  const stageEnds: number[] = [];
  const sizeAfterEachStageEnd: number[] = [];
  const releaseObserver = engine.events.on('stage:end', (payload): void => {
    stageEnds.push(payload.stageIndex);
    sizeAfterEachStageEnd.push(config.boardSize);
  });

  controller.openEngineBoard(engine);

  return {
    controller,
    engine,
    registry,
    config,
    streams,
    stop: (): void => {
      releaseObserver();
      stop();
    },
    stageEnds,
    sizeAfterEachStageEnd,
  };
}

/**
 * Plays moves on a stack, taking `CURSED_ID` the first time it is offered and
 * any card otherwise, so the run reaches the collapse.
 *
 * @param stack Stack to play on.
 * @param moves Number of moves to play.
 * @returns Whether the cursed relic was picked up.
 */
function playTakingTheCurse(stack: Stack, moves: number): boolean {
  let cursed = stack.registry.ownedIds().includes(CURSED_ID);

  for (let index = 0; index < moves; index += 1) {
    stack.engine.move(MOVE_CYCLE[index % MOVE_CYCLE.length] as Direction);

    if (stack.engine.serialize().over || !stack.controller.isRewardPending()) {
      continue;
    }

    const cards = stack.controller.currentOffer();
    const chosen = cards.find((card): boolean => card.id === CURSED_ID) ?? cards[0];

    if (chosen === undefined) {
      throw new Error('a pending reward held no card');
    }

    const selection = stack.controller.selectReward(chosen.id, stack.engine);

    expect(selection.outcome).toBe('accepted');

    if (chosen.id === CURSED_ID) {
      cursed = true;
    }
  }

  return cursed;
}

/**
 * Forces the cursed relic into the run without waiting for it to be offered.
 *
 * Picked up through the registry's own port, so the entry the envelope receives
 * is the one a reward selection would have produced. Used by the cases whose
 * subject is the collapse rather than the draw.
 *
 * @param stack Stack to hold the relic.
 */
function holdTheCurse(stack: Stack): void {
  const held = stack.registry.pickUp(CURSED_ID);

  expect(held).not.toBeUndefined();
}

/** The occupied cells of a board, as `{x, y, value}` triples. */
function occupied(
  board: SerializedGameState,
): readonly { x: number; y: number; value: number }[] {
  const cells: { x: number; y: number; value: number }[] = [];

  board.grid.cells.forEach((column, x): void => {
    column.forEach((tile, y): void => {
      if (tile !== null) {
        cells.push({ x, y, value: tile.value });
      }
    });
  });

  return cells;
}

/** The relic entry the envelope carries for `CURSED_ID`, or `undefined`. */
function storedCurse(stack: Stack): PersistedRelic | undefined {
  return stack.controller
    .state()
    .relics.find((relic): boolean => relic.id === CURSED_ID);
}

/**
 * Plays one leg, ends the stage so the collapse fires, and reports the state the
 * envelope was left in.
 *
 * @param backing Storage shared with the resumed leg.
 * @returns The played stack's outcome, read before the stack is released.
 */
function collapseAndPersist(backing: MemoryStorage): {
  readonly sizeAfterCollapse: number;
  readonly declaredSize: number | undefined;
  readonly board: SerializedGameState;
  readonly cursors: ReturnType<RngStreams['snapshotCursors']>;
  readonly owned: readonly string[];
} {
  const stack = compose(backing);

  holdTheCurse(stack);
  playTakingTheCurse(stack, MOVES_PER_LEG);

  // THE MOVE LIST DID THE WORK, asserted rather than assumed. This helper used
  // to call `engine.endStage(true)` unconditionally right here, which guaranteed
  // a collapse whether or not the played moves still cleared a stage — so a
  // regression in the stage-goal evaluation, in the reward round, or in the
  // relic's own dispatch would have left every case below green. The fallback
  // now lives in `forceStageEndForContrast()` and is used by nothing that
  // asserts on the collapse.
  expect(stack.stageEnds.length).toBeGreaterThan(0);
  expect(stack.registry.ownedIds()).toContain(CURSED_ID);

  // AND THE COLLAPSE HAPPENED ON A STAGE END, not at some other moment: the
  // board was already smaller by the time the first end was observed, which is
  // the hook the relic binds.
  expect(stack.sizeAfterEachStageEnd[0]).toBeLessThan(OPENING_SIZE);
  expect(stack.config.boardSize).toBeLessThan(OPENING_SIZE);

  const entry = storedCurse(stack);
  const declared =
    entry !== undefined &&
    typeof entry.state === 'object' &&
    entry.state !== null &&
    'boardSize' in entry.state &&
    typeof (entry.state as { boardSize?: unknown }).boardSize === 'number'
      ? (entry.state as { boardSize: number }).boardSize
      : undefined;

  const outcome = {
    sizeAfterCollapse: stack.config.boardSize,
    declaredSize: declared,
    board: stack.engine.serialize(),
    cursors: stack.streams.snapshotCursors(),
    owned: stack.registry.ownedIds(),
  };

  stack.stop();

  return outcome;
}

/**
 * Ends the stage by hand.
 *
 * KEPT SEPARATE, and used by nothing that asserts on the collapse. It exists so
 * a case whose subject IS a second `onStageEnd` — the bound the relic's own
 * state slot enforces — can reach one without `collapseAndPersist()` reaching
 * one for every case.
 *
 * @param stack Stack to end the stage on.
 */
function forceStageEndForContrast(stack: Stack): void {
  stack.engine.endStage(true);
}

/* ===== 3. The collapse itself, performed rather than assumed ===== */

describe('a cursed relic collapsing the board through the hook bus', () => {
  it('shrinks the live rules below the size the run opened on', () => {
    const collapsed = collapseAndPersist(new MemoryStorage());

    expect(collapsed.sizeAfterCollapse).toBeLessThan(OPENING_SIZE);
    expect(collapsed.board.grid.size).toBe(collapsed.sizeAfterCollapse);
  });

  it('records the edge length it left, inside its own state slot', () => {
    const collapsed = collapseAndPersist(new MemoryStorage());

    // The slot is what breaks the load-order cycle: the reconciliation reads it
    // before the board it belongs to is rebuilt.
    expect(collapsed.declaredSize).toBe(collapsed.sizeAfterCollapse);
  });

  it('leaves every surviving tile inside the smaller lattice', () => {
    const collapsed = collapseAndPersist(new MemoryStorage());
    const size = collapsed.sizeAfterCollapse;
    const tiles = occupied(collapsed.board);

    expect(tiles.length).toBeGreaterThan(0);

    for (const tile of tiles) {
      expect(tile.x).toBeLessThan(size);
      expect(tile.y).toBeLessThan(size);
      expect(tile.value).toBeGreaterThan(0);
    }
  });

  it('collapses once, however many stage ends it sees', () => {
    // The bound the relic's own state slot enforces, exercised through the ONE
    // path that ends a stage by hand — kept out of `collapseAndPersist()` so no
    // other case depends on it.
    const stack = compose(new MemoryStorage());

    holdTheCurse(stack);
    playTakingTheCurse(stack, MOVES_PER_LEG);

    const collapsedTo = stack.config.boardSize;
    const endsFromPlay = stack.stageEnds.length;

    expect(endsFromPlay).toBeGreaterThan(0);
    expect(collapsedTo).toBeLessThan(OPENING_SIZE);

    forceStageEndForContrast(stack);
    forceStageEndForContrast(stack);

    // A second and third `onStageEnd` narrow nothing further.
    expect(stack.config.boardSize).toBe(collapsedTo);
    expect(stack.engine.serialize().grid.size).toBe(collapsedTo);

    stack.stop();
  });

  it('keeps each tile at the cell it is recorded at, uncompacted', () => {
    const collapsed = collapseAndPersist(new MemoryStorage());

    // The serialised position and the lattice coordinate agree, so nothing was
    // reindexed as the lattice narrowed.
    collapsed.board.grid.cells.forEach((column, x): void => {
      column.forEach((tile, y): void => {
        if (tile !== null) {
          expect(tile.position).toEqual({ x, y });
        }
      });
    });
  });
});

/* ===== 4. The reload: a rebuilt engine at the reconciled size ===== */

describe('a run resumed after the collapse', () => {
  it('rebuilds the lattice at the collapsed size, not the configured one', () => {
    const backing = new MemoryStorage();
    const collapsed = collapseAndPersist(backing);

    // A COMPLETELY NEW STACK. Nothing is carried across in memory: the manager,
    // the store, the bus, the registry, the controller, the generator and the
    // engine are all built again, and a fresh `createDefaultRulesConfig()` opens
    // at the default size — which is what the reconciliation has to override.
    const resumed = compose(backing);

    expect(resumed.controller.state().board.grid.size).toBe(
      collapsed.sizeAfterCollapse,
    );
    expect(resumed.engine.serialize().grid.size).toBe(
      collapsed.sizeAfterCollapse,
    );
    expect(resumed.config.boardSize).toBe(collapsed.sizeAfterCollapse);

    resumed.stop();
  });

  it('restores the relic that caused it, so the collapse is not undone', () => {
    const backing = new MemoryStorage();
    const collapsed = collapseAndPersist(backing);
    const resumed = compose(backing);

    expect(resumed.registry.ownedIds()).toEqual(collapsed.owned);
    expect(resumed.registry.ownedIds()).toContain(CURSED_ID);

    resumed.stop();
  });

  it('reopens on the same tiles it was collapsed with', () => {
    const backing = new MemoryStorage();
    const collapsed = collapseAndPersist(backing);
    const resumed = compose(backing);

    expect(occupied(resumed.engine.serialize())).toEqual(
      occupied(collapsed.board),
    );

    resumed.stop();
  });

  it('resumes every substream cursor the collapse left', () => {
    const backing = new MemoryStorage();
    const collapsed = collapseAndPersist(backing);
    const resumed = compose(backing);

    // The collapse itself draws — it re-homes an exiled tile — so this also says
    // the draws it took were persisted rather than replayed.
    expect(resumed.streams.snapshotCursors()).toEqual(collapsed.cursors);

    resumed.stop();
  });

  it('evaluates the loss probe against the SMALLER board', () => {
    const backing = new MemoryStorage();
    const collapsed = collapseAndPersist(backing);
    const resumed = compose(backing);
    const size = collapsed.sizeAfterCollapse;
    const board = resumed.engine.serialize();

    // The probe reads the reconciled size rather than a captured constant: run
    // against the lattice that exists, its verdict matches the engine's own.
    expect(board.grid.size).toBe(size);
    expect(movesAvailable(resumed.engine.grid, resumed.config)).toBe(
      !resumed.engine.serialize().over,
    );

    resumed.stop();
  });

  it('keeps the win value, which the collapse does not touch', () => {
    const backing = new MemoryStorage();

    collapseAndPersist(backing);

    const resumed = compose(backing);
    const fresh = createDefaultRulesConfig();

    expect(resumed.config.winValue).toBe(fresh.winValue);
    expect(resumed.engine.serialize().won).toBe(false);

    resumed.stop();
  });

  it('plays on from the collapsed board without leaving it', () => {
    const backing = new MemoryStorage();
    const collapsed = collapseAndPersist(backing);
    const resumed = compose(backing);

    for (let index = 0; index < MOVE_CYCLE.length * 2; index += 1) {
      resumed.engine.move(MOVE_CYCLE[index % MOVE_CYCLE.length] as Direction);
    }

    const played = resumed.engine.serialize();

    expect(played.grid.size).toBe(collapsed.sizeAfterCollapse);

    for (const tile of occupied(played)) {
      expect(tile.x).toBeLessThan(collapsed.sizeAfterCollapse);
      expect(tile.y).toBeLessThan(collapsed.sizeAfterCollapse);
    }

    resumed.stop();
  });

  it('collapses no further on the reload than the relic recorded', () => {
    const backing = new MemoryStorage();
    const collapsed = collapseAndPersist(backing);
    const first = compose(backing);

    first.stop();

    // A second reload with nothing played between: the slot bounds the collapse,
    // so reopening cannot narrow the board again by itself.
    const second = compose(backing);

    expect(second.config.boardSize).toBe(collapsed.sizeAfterCollapse);
    expect(second.engine.serialize().grid.size).toBe(
      collapsed.sizeAfterCollapse,
    );

    second.stop();
  });
});
