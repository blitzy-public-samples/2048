// `EngineTracing`: the span wrapper the engine runs its own move resolution
// inside.
//
// WHY THE ENGINE OWNS THIS PLACEMENT
//   The composition root can only wrap `Engine.move()` as a whole, and the turn
//   span opens from INSIDE that call, on `move:before`. Wrapping from outside
//   therefore makes the resolution span the PARENT of the turn it belongs to —
//   inverted nesting — and, worse, closes the turn span by unwinding it the
//   moment the outer wrapper returns, so an idle turn is recorded as an unwind
//   instead of as an idle turn.
//
//   Injecting the wrapper into the engine puts the span where the tracer's own
//   documentation says it belongs: after `move:before` has been emitted and the
//   veto resolved, around the traversal walk and the merge resolution alone.
//
// The properties pinned here:
//   ORDER — the span opens after `move:before` and after the `onBeforeMove`
//   dispatch, and closes before `move:after`.
//   ONCE PER RESOLVED MOVE — a blocked move and a vetoed move never reach it.
//   TRANSPARENT — the outcome the resolver produced is the outcome the turn
//   uses, and a throw is not swallowed.
//   OPTIONAL — an engine built with no port plays exactly as it did before.
//
// The port is declared in src/engine/engine.ts and satisfied structurally by
// `BoundaryTracing` of src/observability/tracer.ts, so neither module imports
// the other.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { Engine } from '../../../src/engine/engine';
import { createRngStreams } from '../../../src/rng/rng-streams';
import { DIRECTION_LEFT } from '../../../src/engine/types';

/* ===== Harness ===== */

const RUN_SEED = 'blitzy-engine-tracing';

/** A board a left move resolves on: two 2s side by side in the top row. */
const MERGE_PAIR = {
  grid: {
    size: 4,
    cells: [
      [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
      [{ position: { x: 1, y: 0 }, value: 2 }, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
    ],
  },
  score: 0,
  over: false,
  won: false,
  keepPlaying: false,
};

/** A board a left move changes nothing on: one tile, already at the wall. */
const IDLE_LEFT = {
  grid: {
    size: 4,
    cells: [
      [{ position: { x: 0, y: 0 }, value: 2 }, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
      [null, null, null, null],
    ],
  },
  score: 0,
  over: false,
  won: false,
  keepPlaying: false,
};

interface Recorder {
  readonly log: string[];
  readonly tracing: { traceMoveResolution: <T>(run: () => T) => T };
}

function createRecorder(): Recorder {
  const log: string[] = [];

  return {
    log,
    tracing: {
      traceMoveResolution: <T>(run: () => T): T => {
        log.push('resolve:open');

        try {
          return run();
        } finally {
          log.push('resolve:close');
        }
      },
    },
  };
}

function createEngine(
  recorder: Recorder | null,
  state?: unknown,
): { engine: Engine; log: string[] } {
  const engine = new Engine({
    config: createDefaultRulesConfig(),
    streams: createRngStreams(RUN_SEED),
    ...(recorder === null ? {} : { tracing: recorder.tracing }),
  });

  const log = recorder?.log ?? [];

  for (const event of ['move:before', 'move:after'] as const) {
    engine.events.on(event, (): void => {
      log.push(event);
    });
  }

  engine.setup(state as never);

  return { engine, log };
}

/* ==========================================================================
 * Placement
 * ========================================================================== */

describe('the injected resolution span', () => {
  it('runs once for a move that resolved', () => {
    const recorder = createRecorder();
    const { engine, log } = createEngine(recorder, MERGE_PAIR);

    engine.move(DIRECTION_LEFT);

    expect(log.filter((entry) => entry === 'resolve:open')).toHaveLength(1);
    expect(log.filter((entry) => entry === 'resolve:close')).toHaveLength(1);
  });

  it('opens AFTER `move:before` and closes BEFORE `move:after`', () => {
    const recorder = createRecorder();
    const { engine, log } = createEngine(recorder, MERGE_PAIR);

    engine.move(DIRECTION_LEFT);

    // This ordering is the whole point of injecting the wrapper rather than
    // wrapping `move()` from outside: the turn span opens on `move:before`, so
    // the resolution span has to open after it to be its child.
    expect(log).toEqual([
      'move:before',
      'resolve:open',
      'resolve:close',
      'move:after',
    ]);
  });

  it('runs for an IDLE move too, which resolves and then changes nothing', () => {
    const recorder = createRecorder();
    const { engine, log } = createEngine(recorder, IDLE_LEFT);

    expect(engine.move(DIRECTION_LEFT)).toBe(false);

    // The walk RAN — it is how the engine learned nothing changed — so the time
    // it took is real and belongs in the trace. The turn then closes on
    // `move:after` carrying `moved: false`, which the engine emits from its
    // no-op branch: the resolution span closes INSIDE that turn, before the
    // completion signal that ends it.
    expect(log).toEqual([
      'move:before',
      'resolve:open',
      'resolve:close',
      'move:after',
    ]);
  });

  it('is not reached by a move a listener withdrew', () => {
    const recorder = createRecorder();
    const { engine, log } = createEngine(recorder, MERGE_PAIR);

    engine.events.on('move:before', (payload): void => {
      payload.cancelled = true;
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(false);

    // A withdrawn move resolves nothing, so a span here would report a
    // resolution that never happened.
    expect(log.includes('resolve:open')).toBe(false);
  });

  it('is not reached once the game is over', () => {
    const recorder = createRecorder();
    const { engine, log } = createEngine(recorder, {
      ...MERGE_PAIR,
      over: true,
    });

    expect(engine.move(DIRECTION_LEFT)).toBe(false);

    expect(log).toEqual([]);
  });
});

/* ==========================================================================
 * Transparency
 * ========================================================================== */

describe('the wrapper is a measurement, not a transformation', () => {
  it('lets the outcome the resolver produced reach the turn unchanged', () => {
    const recorder = createRecorder();
    const traced = createEngine(recorder, MERGE_PAIR);
    const plain = createEngine(null, MERGE_PAIR);

    traced.engine.move(DIRECTION_LEFT);
    plain.engine.move(DIRECTION_LEFT);

    // The merge, the score and the spawn are identical with the wrapper and
    // without it: the seed is the same, so the boards must match cell for cell.
    expect(traced.engine.serialize()).toEqual(plain.engine.serialize());
    expect(traced.engine.score).toBe(plain.engine.score);
  });

  it('propagates a throw from the wrapper rather than absorbing it', () => {
    const engine = new Engine({
      config: createDefaultRulesConfig(),
      streams: createRngStreams(RUN_SEED),
      tracing: {
        traceMoveResolution: <T>(): T => {
          throw new Error('tracer fault');
        },
      },
    });

    engine.setup(MERGE_PAIR as never);

    // A wrapper is composition-root code, not a relic handler: the bus contains
    // a relic's fault deliberately, and swallowing a fault here would hide a
    // broken tracer behind a game that silently stopped resolving moves.
    expect(() => engine.move(DIRECTION_LEFT)).toThrow('tracer fault');
  });

  it('runs the resolution exactly once, not once per call of the wrapper', () => {
    let runs = 0;
    const engine = new Engine({
      config: createDefaultRulesConfig(),
      streams: createRngStreams(RUN_SEED),
      tracing: {
        traceMoveResolution: <T>(run: () => T): T => {
          runs += 1;

          return run();
        },
      },
    });

    engine.setup(MERGE_PAIR as never);
    engine.move(DIRECTION_LEFT);

    expect(runs).toBe(1);
    expect(engine.score).toBe(4);
  });
});

/* ==========================================================================
 * The port is optional
 * ========================================================================== */

describe('an engine with no tracing port', () => {
  it('resolves a move exactly as it did before tracing existed', () => {
    const { engine } = createEngine(null, MERGE_PAIR);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.score).toBe(4);
  });

  it('accepts an empty port object', () => {
    const engine = new Engine({
      config: createDefaultRulesConfig(),
      streams: createRngStreams(RUN_SEED),
      tracing: {},
    });

    engine.setup(MERGE_PAIR as never);

    expect(engine.move(DIRECTION_LEFT)).toBe(true);
    expect(engine.score).toBe(4);
  });
});
