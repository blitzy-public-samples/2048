// Contract suite for the deep copy of src/run/run-state.ts, AAP R6 and
// Contract 5: run state is separate from board state, and a copy handed out
// shares no mutable data with the original.
//
// This suite reads no DOM, no storage and no clock, consumes no randomness,
// installs no mock library and writes no snapshot.

import { describe, expect, it } from 'vitest';

import type {
  LegacyBoardSnapshot,
  RunState,
} from '../../../src/run/run-state';
import {
  RUN_STATE_SCHEMA_VERSION,
  cloneRunState,
  summarizeRunState,
} from '../../../src/run/run-state';

/** Edge length of the board every envelope below wraps. */
const BOARD_SIZE = 4;

/**
 * Builds the wrapped board snapshot, in the persisted `cells[x][y]` shape.
 *
 * @returns A fresh snapshot holding one tile.
 */
function createBoard(): LegacyBoardSnapshot {
  const cells = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => null),
  ) as LegacyBoardSnapshot['grid']['cells'];

  cells[0][0] = { position: { x: 0, y: 0 }, value: 2 };

  return {
    grid: { size: BOARD_SIZE, cells },
    score: 4,
    over: false,
    won: false,
    keepPlaying: false,
  };
}

/**
 * Builds an envelope carrying the relics supplied.
 *
 * @param state Value to put in the single relic's state slot.
 * @param relics Relics to carry instead of that single relic.
 * @returns A fresh envelope.
 */
function createState(
  state: unknown,
  relics?: readonly RunState['relics'][number][],
): RunState {
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: 'run-1',
    seed: 'seed-1',
    rngCursor: {
      'spawn-value': 1,
      'spawn-position': 1,
      'relic-draw': 0,
      'rarity-weight': 0,
    },
    stageIndex: 0,
    stageGoal: { kind: 'score-threshold', target: 100 },
    goalProgress: 0,
    relics: relics ?? [{ id: 'relic-1', charges: 2, state }],
    board: createBoard(),
  };
}

/**
 * Reads the state slot of the first relic of an envelope.
 *
 * @param state Envelope to read.
 * @returns The slot.
 */
function firstRelicState(state: RunState): unknown {
  return state.relics[0].state;
}

describe('cloneRunState copies a relic state slot without aliasing it', () => {
  it('reproduces a nested structure by value at every level', () => {
    const original = createState({
      level1: { level2: { level3: { level4: { counter: 1 } } } },
    });
    const copy = cloneRunState(original);

    expect(firstRelicState(copy)).toEqual(firstRelicState(original));
  });

  it('shares no object with the original at any accepted depth', () => {
    const leaf = { counter: 1 };
    const original = createState({
      a: { b: { c: { d: { e: { f: leaf } } } } },
    });
    const copy = cloneRunState(original);

    leaf.counter = 99;

    type Leaf = { counter: number };
    type Nested = { a: { b: { c: { d: { e: { f: Leaf } } } } } };

    const copied = firstRelicState(copy) as Nested;

    expect(copied.a.b.c.d.e.f.counter).toBe(1);
    expect(copied.a.b.c.d.e.f).not.toBe(leaf);
  });

  it('drops a subtree past the depth bound rather than aliasing it', () => {
    const leaf: Record<string, unknown> = { counter: 1 };
    const original = createState({
      a: { b: { c: { d: { e: { f: { g: { h: { i: leaf } } } } } } } },
    });
    const copied = firstRelicState(cloneRunState(original)) as Record<
      string,
      unknown
    >;
    const flattened = JSON.stringify(copied);

    expect(flattened).not.toContain('99');

    leaf.counter = 99;

    expect(JSON.stringify(firstRelicState(cloneRunState(original)))).toBe(
      flattened.replace('"counter":1', '"counter":99'),
    );
  });

  it('copies an array entry rather than aliasing it', () => {
    const entry = { charges: 3 };
    const original = createState({ history: [[[entry]]] });
    const copy = cloneRunState(original);

    entry.charges = 0;

    const copied = firstRelicState(copy) as {
      history: { charges: number }[][][];
    };

    expect(copied.history[0][0][0].charges).toBe(3);
  });

  it('terminates on a self-referential state and drops the cycle', () => {
    const cyclic: Record<string, unknown> = { counter: 1 };

    cyclic['self'] = cyclic;

    const original = createState(cyclic);
    const copy = cloneRunState(original);
    const copied = firstRelicState(copy) as Record<string, unknown>;

    expect(copied['counter']).toBe(1);
    expect(copied['self']).toBeUndefined();
    expect(copied).not.toBe(cyclic);
    expect(() => JSON.stringify(copied)).not.toThrow();
  });

  it('copies each occurrence of a shared reference on its own', () => {
    const shared = { counter: 1 };
    const original = createState({ left: shared, right: shared });
    const copy = cloneRunState(original);
    const copied = firstRelicState(copy) as {
      left: { counter: number };
      right: { counter: number };
    };

    shared.counter = 99;

    // Each occurrence is rebuilt, which is what `JSON.stringify` does with a
    // repeated reference, so neither side of the copy is the original and a
    // later edit reaches neither.
    expect(copied.left).not.toBe(shared);
    expect(copied.right).not.toBe(shared);
    expect(copied.left).not.toBe(copied.right);
    expect(copied.left).toEqual({ counter: 1 });
    expect(copied.right).toEqual({ counter: 1 });
  });

  it('copies a structure deeper than it descends without aliasing it', () => {
    let deep: Record<string, unknown> = { counter: 1 };

    for (let level = 0; level < 40; level += 1) {
      deep = { next: deep };
    }

    const copy = cloneRunState(createState(deep));

    // The copy neither throws nor carries the over-depth tail by reference:
    // the tail is omitted, so the result is finite and fully detached.
    expect(() => JSON.stringify(copy)).not.toThrow();

    let walked: unknown = firstRelicState(copy);
    let levels = 0;

    while (
      typeof walked === 'object' &&
      walked !== null &&
      'next' in (walked as Record<string, unknown>)
    ) {
      expect(walked).not.toBe(deep);
      walked = (walked as Record<string, unknown>)['next'];
      levels += 1;
    }

    expect(levels).toBeGreaterThan(0);
    expect(levels).toBeLessThan(40);
  });

  it('carries a primitive state slot through unchanged', () => {
    expect(firstRelicState(cloneRunState(createState(7)))).toBe(7);
    expect(firstRelicState(cloneRunState(createState(null)))).toBe(null);
    expect(firstRelicState(cloneRunState(createState('armed')))).toBe('armed');
  });

  it('gives two relics sharing one state object their own copy each', () => {
    const shared = { counter: 1 };
    const copy = cloneRunState(
      createState(shared, [
        { id: 'relic-1', state: shared },
        { id: 'relic-2', state: shared },
      ]),
    );

    expect(copy.relics[0].state).not.toBe(copy.relics[1].state);
    expect(copy.relics[0].state).toEqual(copy.relics[1].state);
  });
});

describe('summarizeRunState copies each relic', () => {
  it('does not alias a relic state subtree into the summary', () => {
    const leaf = { counter: 1 };
    const original = createState({ nested: leaf });
    const summary = summarizeRunState(original);

    leaf.counter = 99;

    const copied = summary.relics[0].state as { nested: { counter: number } };

    expect(copied.nested.counter).toBe(1);
  });

  it('preserves pickup order and the seed', () => {
    const summary = summarizeRunState(
      createState({ counter: 1 }, [
        { id: 'first', state: undefined },
        { id: 'second', state: undefined },
      ]),
    );

    expect(summary.relics.map((relic) => relic.id)).toEqual([
      'first',
      'second',
    ]);
    expect(summary.seed).toBe('seed-1');
  });
});
