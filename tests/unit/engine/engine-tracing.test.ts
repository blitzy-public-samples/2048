// `EngineTracing`: the span wrapper the engine runs its own move resolution
// inside.
//
// Injecting the wrapper into the engine puts the span where the tracer's own
// documentation says it belongs: after `move:before` has been emitted and the
// veto resolved, around the traversal walk and the merge resolution alone.
//
// The port is declared in src/engine/engine.ts and satisfied structurally by
// `BoundaryTracing` of src/observability/tracer.ts, so neither module imports
// the other.

import { describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { Engine } from '../../../src/engine/engine';
import { createRngStreams } from '../../../src/rng/rng-streams';
import type { RngCursorMap } from '../../../src/rng/rng-streams';
import { DIRECTION_LEFT } from '../../../src/engine/types';

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

    // The walk RAN — it is how the engine learned nothing changed — so the
    // time it took is real and belongs in the trace.
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

describe('the wrapper is a measurement, not a transformation', () => {
  it('lets the outcome the resolver produced reach the turn unchanged', () => {
    const recorder = createRecorder();
    const traced = createEngine(recorder, MERGE_PAIR);
    const plain = createEngine(null, MERGE_PAIR);

    traced.engine.move(DIRECTION_LEFT);
    plain.engine.move(DIRECTION_LEFT);

    // The merge, the score and the spawn are identical with the wrapper and
    // without it: the seed is the same, so the boards must match cell for
    // cell.
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

    // A wrapper is composition-root code, not a relic handler: the bus
    // contains a relic's fault deliberately, and swallowing a fault here would
    // hide a broken tracer behind a game that silently stopped resolving
    // moves.
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

describe('a wrapper that breaks the exactly-once contract', () => {
  /** Counter name the engine raises for a contained wrapper violation. */
  const TRACING_FAULT_METRIC = 'engine.move.tracing.fault';

  /**
   * Builds an engine on the merge-pair board with the given wrapper, and
   * collects the counters it reports.
   *
   * @param traceMoveResolution Wrapper to inject, or `undefined` for none.
   * @returns The engine and the counter tally.
   */
  const createCounted = (
    traceMoveResolution?: <T>(run: () => T) => T,
  ): {
    engine: Engine;
    counts: Map<string, number>;
    cursors: () => RngCursorMap;
  } => {
    const counts = new Map<string, number>();
    const streams = createRngStreams(RUN_SEED);
    const engine = new Engine({
      config: createDefaultRulesConfig(),
      streams,
      reporter: {
        onCount: (report): void => {
          counts.set(
            report.metric,
            (counts.get(report.metric) ?? 0) + report.value,
          );
        },
      },
      ...(traceMoveResolution === undefined
        ? {}
        : { tracing: { traceMoveResolution } }),
    });

    engine.setup(MERGE_PAIR as never);

    return {
      engine,
      counts,
      cursors: (): RngCursorMap => streams.snapshotCursors(),
    };
  };

  it('replays the first outcome when a wrapper runs the work twice', () => {
    let runs = 0;
    const traced = createCounted(<T>(run: () => T): T => {
      run();

      return run();
    });
    const plain = createCounted();

    traced.engine.events.on('move:after', (): void => {
      runs += 1;
    });

    expect(traced.engine.move(DIRECTION_LEFT)).toBe(true);
    expect(plain.engine.move(DIRECTION_LEFT)).toBe(true);

    // The defect this pins. The second call re-walked an already-resolved
    // board, which reports `moved: false` with no score delta, and the turn
    // adopted that: the two tiles merged on the board while the score stayed 0
    // and no tile spawned — a half-resolved turn, silently.
    expect(traced.engine.score).toBe(4);
    expect(traced.engine.score).toBe(plain.engine.score);
    expect(traced.engine.serialize()).toEqual(plain.engine.serialize());
    expect(traced.cursors()).toEqual(plain.cursors());
    expect(runs).toBe(1);

    expect(traced.counts.get(TRACING_FAULT_METRIC)).toBe(1);
    expect(plain.counts.get(TRACING_FAULT_METRIC)).toBeUndefined();
  });

  it('keeps the resolver outcome when a wrapper returns one of its own', () => {
    const traced = createCounted(<T>(run: () => T): T => {
      run();

      // A measurement that decided to answer for the work: the shape is a
      // `MoveOutcome` the resolver never produced.
      return { moved: false, merges: [], scoreDelta: 0 } as unknown as T;
    });
    const plain = createCounted();

    expect(traced.engine.move(DIRECTION_LEFT)).toBe(true);
    expect(plain.engine.move(DIRECTION_LEFT)).toBe(true);

    expect(traced.engine.score).toBe(4);
    expect(traced.engine.serialize()).toEqual(plain.engine.serialize());
    expect(traced.cursors()).toEqual(plain.cursors());
    expect(traced.counts.get(TRACING_FAULT_METRIC)).toBe(1);
  });

  it('leaves a well-behaved wrapper uncounted and unchanged', () => {
    const traced = createCounted(<T>(run: () => T): T => run());
    const plain = createCounted();

    expect(traced.engine.move(DIRECTION_LEFT)).toBe(true);
    expect(plain.engine.move(DIRECTION_LEFT)).toBe(true);

    expect(traced.engine.serialize()).toEqual(plain.engine.serialize());
    expect(traced.cursors()).toEqual(plain.cursors());
    expect(traced.counts.get(TRACING_FAULT_METRIC)).toBeUndefined();
  });
});

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
