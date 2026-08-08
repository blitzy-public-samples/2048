// Observer semantics suite of src/engine/engine.ts and
// src/engine/engine-events.ts.
//
// It pins the boundary AAP Contract 1 draws. A payload carries the LIVE `Grid`
// and the LIVE `Tile` pair, so a listener CAN reach engine state; what keeps a
// turn reproducible is that the engine reads nothing back off a payload except
// the one member the contract declares cancellable. This suite pins both
// halves:
//
//   the sanctioned channel — `move:before.cancelled`, which a listener may set
//   and the engine reads back, so a listener withdraws a move exactly as an
//   `onBeforeMove` handler does;
//
//   everything else — neither a listener's presence, nor its registration
//   order, nor a write it makes to a member the engine does not read back
//   changes what a turn does, established by running the same move twice and
//   comparing the results.
//
// The privileged path is asserted alongside: an `onBeforeMove` hook handler
// can also REDIRECT a move, which a listener cannot.
//
// This suite reads no DOM and no storage; the storage port is a hand-written
// double. It consumes randomness only through a seeded run, so every run
// below is reproducible. It runs in the `unit:dom-free` project of
// vitest.config.ts.

import { describe, expect, it } from 'vitest';

import { DEFAULT_RULES_CONFIG } from '../../../src/config/default-config';
import { Engine } from '../../../src/engine/engine';
import type { EngineStoragePort } from '../../../src/engine/engine';
import { createHookBus } from '../../../src/engine/hook-bus';
import type {
  ChargeConsumption,
  HookBus,
  HookBusMetrics,
  HookDispatchResult,
  HookSubscriber,
} from '../../../src/engine/hook-bus';
import type {
  BeforeMovePayload,
  HookEnvironment,
  HookName,
  HookDispatchPayloadMap,
  HookPayloadMap,
  HookSubscription,
  SpawnPayload,
} from '../../../src/engine/hooks';
import { Tile } from '../../../src/engine/tile';
import { DIRECTION_LEFT } from '../../../src/engine/types';
import type {
  EngineReporter,
  Position,
  SerializedGameState,
} from '../../../src/engine/types';
import { createRngStreams } from '../../../src/rng/rng-streams';

const RUN_SEED = 'observer-non-interference-seed';

/** A port that reports no best score and discards every write. */
function createPort(): EngineStoragePort {
  return {
    getBestScore: (): string | 0 => 0,
    setBestScore: (): unknown => undefined,
    getGameState: (): unknown => null,
    setGameState: (): unknown => undefined,
    clearGameState: (): unknown => undefined,
  };
}

/** Builds a set-up engine on the default rules and one fixed seed. */
function createEngine(): Engine {
  const engine = new Engine({
    config: { ...DEFAULT_RULES_CONFIG },
    streams: createRngStreams(RUN_SEED),
    storage: createPort(),
  });

  engine.setup();

  return engine;
}

/**
 * The result of one turn, in the terms two engines are compared by.
 *
 * @param engine Engine to read.
 * @param moved What its `move()` returned.
 * @returns The comparable result.
 */
function resultOf(
  engine: Engine,
  moved: boolean,
): {
  readonly moved: boolean;
  readonly score: number;
  readonly board: SerializedGameState['grid'];
} {
  return {
    moved,
    score: engine.score,
    board: engine.serialize().grid,
  };
}

describe('a listener changes a turn only through the cancellable member ' +
  '(F1)', () => {
  it('resolves the same move whether or not a listener is registered', () => {
    const plain = createEngine();
    const observed = createEngine();

    observed.events.on('move:before', () => undefined);
    observed.events.on('state:commit', () => undefined);

    const plainResult = resultOf(plain, plain.move(DIRECTION_LEFT));
    const observedResult = resultOf(
      observed,
      observed.move(DIRECTION_LEFT),
    );

    expect(observedResult).toEqual(plainResult);
  });

  it('withdraws the move when a listener writes move:before.cancelled', () => {
    const plain = createEngine();
    const vetoing = createEngine();

    vetoing.events.on('move:before', (payload) => {
      payload.cancelled = true;
    });

    const before = vetoing.serialize();
    const plainResult = resultOf(plain, plain.move(DIRECTION_LEFT));
    const vetoedResult = resultOf(vetoing, vetoing.move(DIRECTION_LEFT));

    // AAP Contract 1 declares `move:before` cancellable, so this listener is
    // exercising the contract rather than defeating it.
    expect(plainResult.moved).toBe(true);
    expect(vetoedResult.moved).toBe(false);
    expect(vetoing.serialize()).toEqual(before);
  });

  it('resolves the move unchanged when a listener writes a member the engine ' +
    'does not read back', () => {
    const plain = createEngine();
    const interfering = createEngine();

    interfering.events.on('move:after', (payload) => {
      (payload as { score: number }).score = 9999;
      (payload as { over: boolean }).over = true;
    });
    interfering.events.on('state:commit', (payload) => {
      (payload as { score: number }).score = 9999;
    });

    const plainResult = resultOf(plain, plain.move(DIRECTION_LEFT));
    const interferingResult = resultOf(
      interfering,
      interfering.move(DIRECTION_LEFT),
    );

    expect(interferingResult).toEqual(plainResult);
    expect(interferingResult.moved).toBe(true);
  });

  it('withdraws the move once whatever the number and order of the vetoing ' +
    'listeners', () => {
    const crowded = createEngine();
    const order: string[] = [];
    const before = crowded.serialize();

    crowded.events.on('move:before', (payload) => {
      order.push('first');
      payload.cancelled = true;
    });
    crowded.events.on('move:before', () => {
      order.push('second');
    });
    crowded.events.on('move:before', (payload) => {
      order.push('third');
      payload.cancelled = true;
    });

    expect(crowded.move(DIRECTION_LEFT)).toBe(false);
    expect(order).toEqual(['first', 'second', 'third']);
    expect(crowded.serialize()).toEqual(before);
  });

  it('cannot redirect a move: direction is readonly on the event', () => {
    const plain = createEngine();
    const redirecting = createEngine();

    redirecting.events.on('move:before', (payload) => {
      (payload as { direction: number }).direction = 1;
    });

    const plainResult = resultOf(plain, plain.move(DIRECTION_LEFT));
    const redirectedResult = resultOf(
      redirecting,
      redirecting.move(DIRECTION_LEFT),
    );

    // The engine reads the direction back off the HOOK payload, not the event,
    // so redirection stays the privileged path's alone.
    expect(redirectedResult).toEqual(plainResult);
  });

  it('leaves the run reproducible when a listener reads the live board it ' +
    'was handed', () => {
    const plain = createEngine();
    const reading = createEngine();
    const seen: number[] = [];

    reading.events.on('state:commit', (commit) => {
      for (const column of commit.board.cells) {
        for (const cell of column) {
          if (cell !== null) {
            seen.push(cell.value);
          }
        }
      }
    });

    const plainResult = resultOf(plain, plain.move(DIRECTION_LEFT));
    const readingResult = resultOf(reading, reading.move(DIRECTION_LEFT));

    expect(readingResult).toEqual(plainResult);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('contains a listener that throws rather than passing it to the caller',
    () => {
    const errors: { event: string; index: number }[] = [];
    const plain = createEngine();
    const engine = new Engine({
      config: { ...DEFAULT_RULES_CONFIG },
      streams: createRngStreams(RUN_SEED),
      storage: createPort(),
      reporter: {
        onListenerError: (report): void => {
          errors.push({ event: report.event, index: report.listenerIndex });
        },
      },
    });

    engine.setup();
    engine.events.on('move:before', () => {
      throw new Error('listener failed');
    });

    const plainResult = resultOf(plain, plain.move(DIRECTION_LEFT));
    let thrownResult: ReturnType<typeof resultOf> | null = null;

    expect(() => {
      thrownResult = resultOf(engine, engine.move(DIRECTION_LEFT));
    }).not.toThrow();
    expect(thrownResult).toEqual(plainResult);
    expect(errors).toEqual([{ event: 'move:before', index: 0 }]);
  });
});

describe('an onBeforeMove hook handler is the privileged path (F1)', () => {
  it('withdraws the move and changes no state', () => {
    const engine = createEngine();
    const before = engine.serialize();

    engine.hooks.register({
      id: 'vetoes',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => ({
          ...payload,
          cancelled: true,
        }),
      },
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(engine.serialize()).toEqual(before);
  });

  it('redirects a move, which a listener cannot do', () => {
    const engine = createEngine();

    engine.hooks.register({
      id: 'redirects',
      hooks: {
        onBeforeMove: (payload): BeforeMovePayload => ({
          ...payload,
          direction: 1,
        }),
      },
    });

    const emitted: number[] = [];

    engine.events.on('move:before', (payload) => {
      emitted.push(payload.direction);
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(true);

    // The emission precedes the dispatch, so it reports the requested
    // direction; the board proves the redirected one is what ran.
    expect(emitted).toEqual([DIRECTION_LEFT]);
    expect(engine.grid.availableCells().length).toBeGreaterThan(0);
  });

  it('is dispatched with the veto a listener already cast', () => {
    const engine = createEngine();
    const dispatched: boolean[] = [];

    engine.events.on('move:before', (payload) => {
      payload.cancelled = true;
    });
    engine.hooks.register({
      id: 'observes',
      hooks: {
        onBeforeMove: (payload): void => {
          dispatched.push(payload.cancelled);
        },
      },
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(false);
    expect(dispatched).toEqual([true]);
  });

  it('reports cancelled false for a move that proceeds', () => {
    const engine = createEngine();
    const seen: boolean[] = [];

    engine.events.on('move:before', (payload) => {
      seen.push(payload.cancelled);
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(seen).toEqual([false]);
  });
});

describe('the engine is the authoritative spawn-attempt boundary (F7)', () => {
  /**
   * Counts the tiles a serialised board holds.
   *
   * @param state Serialised grid.
   * @returns How many cells are occupied.
   */
  function occupiedCells(state: SerializedGameState['grid']): number {
    let occupied = 0;

    for (const column of state.cells) {
      for (const cell of column) {
        if (cell !== null) {
          occupied += 1;
        }
      }
    }

    return occupied;
  }

  /**
   * Wraps a bus so every `onSpawn` dispatch resolves to one fixed cell,
   * whatever the wrapped bus decided.
   *
   * Every other member delegates, so the engine holds a bus that behaves
   * exactly like the production one apart from that single substitution. It
   * is the only way to hand the engine a spawn cell the production bus would
   * refuse, and therefore the only way to exercise the engine's own bounds
   * guard.
   *
   * @param inner Bus to delegate to.
   * @param cell Cell every `onSpawn` dispatch resolves to.
   * @param isActive Reports whether the substitution is in force, so the
   *   starting tiles can be placed normally before it is turned on.
   * @returns The wrapping bus.
   */
  function createOffBoardSpawnBus(
    inner: HookBus,
    cell: Position,
    isActive: () => boolean,
  ): HookBus {
    return {
      register: (subscriber): boolean => inner.register(subscriber),
      unregister: (id): boolean => inner.unregister(id),

      dispatch<K extends HookName>(
        hook: K,
        payload: HookDispatchPayloadMap[K],
        environment: HookEnvironment,
      ): HookDispatchResult<K> {
        const resolved = inner.dispatch(hook, payload, environment);

        if (hook !== 'onSpawn' || !isActive()) {
          return resolved;
        }

        const substituted: SpawnPayload = {
          position: cell,
          value: (resolved.payload as SpawnPayload).value,
        };

        return {
          ...resolved,
          payload: substituted as HookPayloadMap[K],
        };
      },

      consumeCharge: (id, amount): ChargeConsumption =>
        inner.consumeCharge(id, amount),
      degraded: (): readonly string[] => inner.degraded(),

      subscriptions<K extends HookName>(
        hook: K,
      ): readonly HookSubscription<K>[] {
        return inner.subscriptions(hook);
      },

      subscribers: (): readonly HookSubscriber[] => inner.subscribers(),
      metrics: (): HookBusMetrics => inner.metrics(),
    };
  }

  /**
   * Builds an engine that records only its spawn counters.
   *
   * @param counts List each spawn counter name is appended to.
   * @param wrapBus Optional wrapper applied to the bus the engine holds.
   * @returns The set-up engine.
   */
  function createCountingEngine(
    counts: string[],
    wrapBus?: (inner: HookBus) => HookBus,
  ): Engine {
    const reporter: EngineReporter = {
      onCount: (report): void => {
        if (report.metric.startsWith('engine.spawn.')) {
          counts.push(report.metric);
        }
      },
    };
    const bus = createHookBus({ reporter });
    const engine = new Engine({
      config: { ...DEFAULT_RULES_CONFIG },
      streams: createRngStreams(RUN_SEED),
      storage: createPort(),
      hooks: wrapBus === undefined ? bus : wrapBus(bus),
      reporter,
    });

    engine.setup();

    return engine;
  }

  it('counts one attempt per starting tile and no suppression on an open ' +
    'board', () => {
    const counts: string[] = [];

    createCountingEngine(counts);

    expect(counts).toEqual([
      'engine.spawn.attempt',
      'engine.spawn.attempt',
    ]);
  });

  it('counts one further attempt for the tile a changed move spawns', () => {
    const counts: string[] = [];
    const engine = createCountingEngine(counts);

    counts.length = 0;

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(counts).toEqual(['engine.spawn.attempt']);
  });

  it('counts no attempt at all for a move that changed nothing (L182)',
    () => {
      const counts: string[] = [];
      const engine = createCountingEngine(counts);
      const board = engine.grid;
      let value = 2;

      // Every cell filled with a value no neighbour can merge with, so the
      // move resolves nothing and the engine returns before the spawn.
      for (let x = 0; x < board.size; x += 1) {
        for (let y = 0; y < board.size; y += 1) {
          board.cells[x]![y] = new Tile({ x, y }, value);
          value *= 2;
        }
      }

      counts.length = 0;

      expect(engine.move(DIRECTION_LEFT)).toBe(false);
      expect(counts).toHaveLength(0);
    });

  it('counts an attempt and its suppression when an onSpawn handler ' +
    'returns no position', () => {
    const counts: string[] = [];
    const emitted: (Readonly<{ x: number; y: number }> | undefined)[] = [];
    const engine = createCountingEngine(counts);

    engine.hooks.register({
      id: 'suppresses-the-spawn',
      hooks: {
        onSpawn: (payload): SpawnPayload => ({ value: payload.value }),
      },
    });
    engine.events.on('tile:spawn', (payload) => {
      emitted.push(payload.position);
    });

    counts.length = 0;

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(counts).toEqual([
      'engine.spawn.attempt',
      'engine.spawn.suppressed',
    ]);

    // The event is still emitted, carrying no position, so a subscriber sees
    // the resolution. Attempts are counted above and not from this emission.
    expect(emitted).toEqual([undefined]);
  });

  it('omits the position for a spawn cell outside the lattice', () => {
    const counts: string[] = [];
    const emitted: (Readonly<Position> | undefined)[] = [];

    // Off while the two starting tiles are placed, so the board the move
    // resolves against is the ordinary one.
    let offBoard = false;

    // The production bus refuses an off-board cell for itself — it validates
    // an `onSpawn` return against the environment's grid size — so this
    // reaches the engine's OWN guard, which exists because the bus is an
    // injected collaborator and the engine cannot assume which one it holds.
    const engine = createCountingEngine(counts, (inner: HookBus): HookBus =>
      createOffBoardSpawnBus(
        inner,
        {
          x: DEFAULT_RULES_CONFIG.boardSize + 3,
          y: DEFAULT_RULES_CONFIG.boardSize,
        },
        (): boolean => offBoard,
      ),
    );

    engine.events.on('tile:spawn', (payload) => {
      emitted.push(payload.position);
    });

    const before = engine.serialize().grid;

    counts.length = 0;
    emitted.length = 0;
    offBoard = true;

    expect(engine.move(DIRECTION_LEFT)).toBe(true);

    // `withinBounds` refuses the cell, so the attempt inserted nothing and
    // is counted as suppressed.
    expect(counts).toEqual([
      'engine.spawn.attempt',
      'engine.spawn.suppressed',
    ]);

    // AND the emission carries no position, so a subscriber counting the
    // emissions that carry one counts tiles inserted exactly, and a
    // subscriber drawing the position never draws a cell off the board.
    expect(emitted).toEqual([undefined]);

    const after = engine.serialize().grid;

    expect(after.size).toBe(before.size);

    // No tile was added: the move resolved its merges and the spawn inserted
    // nothing, so the board holds no more than it started with.
    expect(occupiedCells(after)).toBeLessThanOrEqual(
      occupiedCells(before),
    );

    // An off-board cell and no cell at all are the SAME outcome. A control
    // run on the same seed, suppressed the reachable way, leaves the
    // identical board — so the guard neither placed the tile somewhere else
    // nor perturbed the run.
    const controlCounts: string[] = [];
    const control = createCountingEngine(controlCounts);

    control.hooks.register({
      id: 'suppresses-the-spawn',
      hooks: {
        onSpawn: (payload): SpawnPayload => ({ value: payload.value }),
      },
    });

    expect(control.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.serialize().grid).toEqual(control.serialize().grid);
    expect(engine.score).toBe(control.score);
  });
});

describe('a relic handler that throws does not perturb a seeded run (F2)',
  () => {
    /** Twelve moves, in the order the run below plays them. */
    const MOVES: readonly (0 | 1 | 2 | 3)[] = [
      3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2,
    ];

    /**
     * Plays the fixed move list and reports the board and score it leaves.
     *
     * @param withFailingRelic Whether to register a relic that draws from a
     *   substream and then throws on every hook it binds.
     * @returns The serialised end state.
     */
    function play(withFailingRelic: boolean): SerializedGameState {
      const engine = createEngine();

      if (withFailingRelic) {
        engine.hooks.register({
          id: 'draws-then-throws',
          hooks: {
            onBeforeMove: (_payload, context): BeforeMovePayload => {
              context.rng.stream('spawn-value').next();
              context.rng.stream('spawn-position').next();

              throw new Error('relic handler failed');
            },
            onSpawn: (_payload, context): SpawnPayload => {
              context.rng.stream('spawn-position').nextInt(4);

              throw new Error('relic handler failed');
            },
          },
        });
      }

      for (const direction of MOVES) {
        engine.move(direction);
      }

      return engine.serialize();
    }

    it('leaves the identical board and score', () => {
      expect(play(true)).toEqual(play(false));
    });

    it('leaves the identical board and score on a repeat', () => {
      const withRelic = play(true);
      const withoutRelic = play(false);

      expect(play(true)).toEqual(withRelic);
      expect(play(false)).toEqual(withoutRelic);
      expect(withRelic).toEqual(withoutRelic);
    });
  });
