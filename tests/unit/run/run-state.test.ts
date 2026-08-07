// Trust-boundary suite of src/run/run-state.ts: the envelope's structural
// validation, its deep copy, and the JSON round-trip contract its module
// header states.
//
// The contract under test, from that header: "Every member of `RunState` is
// JSON data ... so `JSON.parse(JSON.stringify(state))` is deep-equal to
// `state`". A relic's own `state` is the one member the wire types as
// `unknown`, so it is the one member on which that promise has to be
// enforced rather than declared. `PersistedRelicState` states the vocabulary
// it is drawn from, `checkRelicState()` decides membership as part of
// `isRunStateShape()`, and `cloneRelicState()` carries nothing outside it.
//
// Sections, each naming the construct it exercises:
//   1  isPersistedRelicState()   the vocabulary, value by value
//   2  describeRunStateProblems()  relic state diagnosed field-scoped
//   3  isRunStateShape()         the predicate the store gates writes on
//   4  cloneRunState()           detachment, and the JSON projection
//   5  RunStateStore             the boundary the two above compose into
//
// Every hostile input below is one a stored envelope can actually carry:
// `JSON.parse` produces `__proto__` as an ordinary own data property, and a
// value assembled in memory can hold a function, a cycle or an accessor.
//
// This suite reads no DOM, installs no mock and replaces no global; the one
// test double is the hand-written persistence port in section 5. It is
// collected by the `unit:dom` project of vitest.config.ts, whose environment
// is 'jsdom', because tests/unit/run is not one of that config's DOM-free
// directories; nothing here touches a document.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { describe, expect, it } from 'vitest';

import { EMPTY_BOARD, copyBoard } from '../../fixtures/boards';
import {
  RUN_STATE_SCHEMA_VERSION,
  cloneRunState,
  createFreshRunState,
  describeRunStateProblems,
  isPersistedRelicState,
  isRunStateShape,
} from '../../../src/run/run-state';
import type { PersistedRelic, RunState } from '../../../src/run/run-state';
import { RunStateStore } from '../../../src/run/run-state-store';
import type { RunStatePersistencePort } from '../../../src/run/run-state-store';
import { RUN_STATE_KEY } from '../../../src/storage/storage-keys';
import type { OwnedStorageKey } from '../../../src/storage/storage-keys';

/* ===== Fixtures ===== */

/**
 * Builds a fresh envelope wrapping the empty-board fixture.
 *
 * @param relics Relics to place in pickup order. Defaults to none.
 * @returns The envelope.
 */
function envelope(relics: readonly PersistedRelic[] = []): RunState {
  const state = createFreshRunState({
    runId: 'run-1',
    seed: 'seed-42',
    rngCursor: { 'spawn-value': 2, 'spawn-position': 2 },
    stageIndex: 0,
    stageGoal: { kind: 'highest-tile', target: 64 },
    board: copyBoard(EMPTY_BOARD),
  });

  return { ...state, relics: relics.slice() };
}

/** Every problem reported for one relic's `state` member. */
function stateProblems(state: unknown): string[] {
  return describeRunStateProblems(
    envelope([{ id: 'relic-1', state }])
  ).filter((problem) => problem.startsWith('relics[0].state'));
}

/* ===== 1. isPersistedRelicState() ===== */

describe('isPersistedRelicState accepts the persistable vocabulary', () => {
  it('accepts each primitive the vocabulary names', () => {
    expect(isPersistedRelicState('flagged')).toBe(true);
    expect(isPersistedRelicState(0)).toBe(true);
    expect(isPersistedRelicState(-12.5)).toBe(true);
    expect(isPersistedRelicState(true)).toBe(true);
    expect(isPersistedRelicState(false)).toBe(true);
    expect(isPersistedRelicState(null)).toBe(true);
  });

  it('accepts a plain object of counters and flags', () => {
    expect(
      isPersistedRelicState({ fired: 3, armed: true, note: 'primed' })
    ).toBe(true);
  });

  it('accepts an array and an empty container', () => {
    expect(isPersistedRelicState([1, 'two', false, null])).toBe(true);
    expect(isPersistedRelicState({})).toBe(true);
    expect(isPersistedRelicState([])).toBe(true);
  });

  it('accepts nesting up to the depth the copy descends to', () => {
    // Eight levels below the member itself: the deepest value the copy
    // reaches, and therefore the deepest the validation accepts.
    let deep: unknown = 'leaf';

    for (let level = 0; level < 8; level += 1) {
      deep = { deep };
    }

    expect(isPersistedRelicState(deep)).toBe(true);
  });

  it('accepts a null-prototype object of data', () => {
    const bare = Object.create(null) as Record<string, unknown>;

    bare.fired = 1;

    expect(isPersistedRelicState(bare)).toBe(true);
  });
});

describe('isPersistedRelicState refuses what persistence cannot carry', () => {
  it('refuses a number that is not finite', () => {
    expect(isPersistedRelicState(Number.NaN)).toBe(false);
    expect(isPersistedRelicState(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isPersistedRelicState(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('refuses undefined, a function, a symbol and a bigint', () => {
    expect(isPersistedRelicState(undefined)).toBe(false);
    expect(isPersistedRelicState((): void => undefined)).toBe(false);
    expect(isPersistedRelicState(Symbol('state'))).toBe(false);
    expect(isPersistedRelicState(BigInt(1))).toBe(false);
  });

  it('refuses an object that is not data alone', () => {
    expect(isPersistedRelicState(new Date(0))).toBe(false);
    expect(isPersistedRelicState(new Map())).toBe(false);
    expect(isPersistedRelicState(new Set())).toBe(false);
    expect(isPersistedRelicState(/pattern/)).toBe(false);
    expect(isPersistedRelicState(new Error('state'))).toBe(false);
  });

  it('refuses a member holding one of those values', () => {
    expect(isPersistedRelicState({ at: new Date(0) })).toBe(false);
    expect(isPersistedRelicState({ run: (): void => undefined })).toBe(false);
    expect(isPersistedRelicState({ absent: undefined })).toBe(false);
    expect(isPersistedRelicState([Number.NaN])).toBe(false);
  });

  it('refuses each reserved member name', () => {
    expect(
      isPersistedRelicState(JSON.parse('{"__proto__":{"polluted":true}}'))
    ).toBe(false);
    expect(isPersistedRelicState(JSON.parse('{"constructor":1}'))).toBe(false);
    expect(isPersistedRelicState(JSON.parse('{"prototype":1}'))).toBe(false);
  });

  it('refuses an accessor rather than running it', () => {
    let reads = 0;
    const hostile = {
      get fired(): number {
        reads += 1;

        return 1;
      },
    };

    expect(isPersistedRelicState(hostile)).toBe(false);
    expect(reads).toBe(0);
  });

  it('refuses a symbol-keyed member', () => {
    const tagged: Record<string, unknown> = { fired: 1 };

    Object.defineProperty(tagged, Symbol('tag'), {
      value: 1,
      enumerable: true,
    });

    expect(isPersistedRelicState(tagged)).toBe(false);
  });

  it('refuses a value nested deeper than the copy descends', () => {
    let deep: unknown = 'leaf';

    for (let level = 0; level < 9; level += 1) {
      deep = { deep };
    }

    expect(isPersistedRelicState(deep)).toBe(false);
  });

  it('refuses a cycle without recursing forever', () => {
    const cyclic: Record<string, unknown> = { fired: 1 };

    cyclic.self = cyclic;

    expect(isPersistedRelicState(cyclic)).toBe(false);
  });

  it('refuses a cycle through an array', () => {
    const entries: unknown[] = [1];

    entries.push(entries);

    expect(isPersistedRelicState(entries)).toBe(false);
  });

  it('accepts the same value reached twice by different paths', () => {
    // Shared, not cyclic: only an ancestor is a cycle.
    const shared = { fired: 1 };

    expect(isPersistedRelicState({ left: shared, right: shared })).toBe(true);
  });

  it('refuses an array hole', () => {
    const sparse: unknown[] = [1];

    sparse.length = 3;

    expect(isPersistedRelicState(sparse)).toBe(false);
  });
});

/* ===== 2. describeRunStateProblems() names the offending member ===== */

describe('describeRunStateProblems diagnoses relic state field-scoped', () => {
  it('reports nothing for an absent state member', () => {
    expect(describeRunStateProblems(envelope([{ id: 'relic-1' }]))).toEqual(
      []
    );
  });

  it('reports nothing for a state of counters and flags', () => {
    expect(
      describeRunStateProblems(
        envelope([{ id: 'relic-1', charges: 2, state: { fired: 1 } }])
      )
    ).toEqual([]);
  });

  it('names the dotted path of a refused nested member', () => {
    expect(stateProblems({ inner: { at: new Date(0) } })).toEqual([
      'relics[0].state.inner.at is not a plain object or array',
    ]);
  });

  it('names the index of a refused array entry', () => {
    expect(stateProblems({ counts: [1, Number.NaN] })).toEqual([
      'relics[0].state.counts[1] is not a finite number',
    ]);
  });

  it('names a reserved member name', () => {
    const hostile: unknown = JSON.parse('{"__proto__":{"polluted":true}}');

    expect(stateProblems(hostile)).toEqual([
      'relics[0].state.__proto__ is a reserved member name',
    ]);
  });

  it('names a cycle once', () => {
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    expect(stateProblems(cyclic)).toEqual([
      'relics[0].state.self refers back to a value containing it',
    ]);
  });

  it('names an accessor', () => {
    expect(
      stateProblems({
        get fired(): number {
          return 1;
        },
      })
    ).toEqual(['relics[0].state.fired is an accessor']);
  });

  it('keeps the pickup index of the offending relic', () => {
    const problems = describeRunStateProblems(
      envelope([
        { id: 'first' },
        { id: 'second', state: { run: (): void => undefined } },
      ])
    );

    expect(problems).toEqual([
      'relics[1].state.run is a function and is not persistable',
    ]);
  });

  it('reports a bounded list for a wide corrupt state', () => {
    const wide: Record<string, unknown> = {};

    for (let index = 0; index < 200; index += 1) {
      wide[`member-${index}`] = undefined;
    }

    const problems = describeRunStateProblems(
      envelope([{ id: 'relic-1', state: wide }])
    );

    expect(problems.length).toBeLessThanOrEqual(32);
    expect(problems[problems.length - 1]).toBe(
      'further problems were not reported'
    );
  });

  it('reports a member an accessor refuses rather than throwing', () => {
    const hostile: PersistedRelic = {
      id: 'relic-1',

      get state(): unknown {
        throw new Error('refused');
      },
    };

    expect(() => describeRunStateProblems(envelope([hostile]))).not.toThrow();
    expect(describeRunStateProblems(envelope([hostile]))).toContain(
      'relics[0].state is not readable'
    );
  });
});

/* ===== 3. isRunStateShape() gates the write ===== */

describe('isRunStateShape decides relic state with the diagnosis', () => {
  it('accepts an envelope whose relic state is persistable', () => {
    expect(
      isRunStateShape(envelope([{ id: 'relic-1', state: { fired: 1 } }]))
    ).toBe(true);
  });

  it('refuses an envelope whose relic state is not', () => {
    expect(
      isRunStateShape(envelope([{ id: 'relic-1', state: new Date(0) }]))
    ).toBe(false);
    expect(
      isRunStateShape(
        envelope([
          { id: 'relic-1', state: JSON.parse('{"__proto__":{"x":1}}') },
        ])
      )
    ).toBe(false);
  });

  it('agrees with describeRunStateProblems on every input', () => {
    const candidates: unknown[] = [
      envelope(),
      envelope([{ id: 'relic-1', state: { fired: 1 } }]),
      envelope([{ id: 'relic-1', state: undefined }]),
      envelope([{ id: 'relic-1', state: new Map() }]),
      envelope([{ id: 'relic-1', state: [Symbol('x')] }]),
      null,
      undefined,
      'envelope',
      [],
    ];

    for (const candidate of candidates) {
      expect(isRunStateShape(candidate)).toBe(
        describeRunStateProblems(candidate).length === 0
      );
    }
  });
});

/* ===== 4. cloneRunState() detaches, and projects onto JSON ===== */

describe('cloneRunState detaches every part of the envelope', () => {
  it('shares no object with the original', () => {
    const original = envelope([
      { id: 'relic-1', charges: 2, state: { fired: 1, log: [1, 2] } },
    ]);
    const copy = cloneRunState(original);

    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(copy.relics).not.toBe(original.relics);
    expect(copy.relics[0]).not.toBe(original.relics[0]);
    expect(copy.relics[0].state).not.toBe(original.relics[0].state);
    expect(copy.rngCursor).not.toBe(original.rngCursor);
    expect(copy.board).not.toBe(original.board);
    expect(copy.board.grid.cells).not.toBe(original.board.grid.cells);
  });

  it('detaches a nested state subtree at every level', () => {
    const nested = { a: { b: { c: { d: { e: { f: ['leaf'] } } } } } };
    const original = envelope([{ id: 'relic-1', state: nested }]);
    const copy = cloneRunState(original);
    const copied = copy.relics[0].state as typeof nested;

    expect(copied).toEqual(nested);
    expect(copied.a).not.toBe(nested.a);
    expect(copied.a.b.c.d.e).not.toBe(nested.a.b.c.d.e);
    expect(copied.a.b.c.d.e.f).not.toBe(nested.a.b.c.d.e.f);
  });

  it('leaves a later mutation of the original invisible to the copy', () => {
    const state: { fired: number; log: number[] } = { fired: 1, log: [1] };
    const original = envelope([{ id: 'relic-1', state }]);
    const copy = cloneRunState(original);

    state.fired = 99;
    state.log.push(2);

    expect(copy.relics[0].state).toEqual({ fired: 1, log: [1] });
  });

  it('omits the state member the original omits', () => {
    const copy = cloneRunState(envelope([{ id: 'relic-1' }]));

    expect(Object.prototype.hasOwnProperty.call(copy.relics[0], 'state')).toBe(
      false
    );
    expect(
      Object.prototype.hasOwnProperty.call(copy.relics[0], 'charges')
    ).toBe(false);
  });

  it('preserves relic pickup order', () => {
    const copy = cloneRunState(
      envelope([{ id: 'first' }, { id: 'second' }, { id: 'third' }])
    );

    expect(copy.relics.map((relic) => relic.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('round-trips through JSON unchanged', () => {
    const original = envelope([
      { id: 'relic-1', charges: 0, state: { fired: 3, log: [1, null] } },
      { id: 'relic-2' },
    ]);
    const copy = cloneRunState(original);

    expect(JSON.parse(JSON.stringify(copy))).toEqual(copy);
    expect(JSON.parse(JSON.stringify(copy))).toEqual(original);
  });
});

describe('cloneRunState carries data alone', () => {
  it('never carries a source reference at the depth bound', () => {
    let deep: Record<string, unknown> = { leaf: 'value' };
    const deepest = deep;

    for (let level = 0; level < 12; level += 1) {
      deep = { deep };
    }

    const copy = cloneRunState(envelope([{ id: 'relic-1', state: deep }]));

    expect(JSON.stringify(copy)).not.toContain('leaf');
    expect(deepest.leaf).toBe('value');
  });

  it('drops a cycle instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { fired: 1 };

    cyclic.self = cyclic;

    const copy = cloneRunState(envelope([{ id: 'relic-1', state: cyclic }]));

    expect(copy.relics[0].state).toEqual({ fired: 1 });
    expect(() => JSON.stringify(copy)).not.toThrow();
  });

  it('defines a stored __proto__ member without reaching a prototype', () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true},"fired":1}');
    const copy = cloneRunState(envelope([{ id: 'relic-1', state: hostile }]));
    const copied = copy.relics[0].state as Record<string, unknown>;

    expect(copied).toEqual({ fired: 1 });
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect('polluted' in copied).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('drops the values JSON cannot carry as data', () => {
    const copy = cloneRunState(
      envelope([
        {
          id: 'relic-1',
          state: {
            fired: 1,
            absent: undefined,
            run: (): void => undefined,
            at: new Date(0),
            broken: Number.NaN,
          },
        },
      ])
    );

    expect(copy.relics[0].state).toEqual({ fired: 1 });
  });

  it('carries a dropped array entry as null so later indices hold', () => {
    const copy = cloneRunState(
      envelope([{ id: 'relic-1', state: { log: [1, Number.NaN, 3] } }])
    );

    expect(copy.relics[0].state).toEqual({ log: [1, null, 3] });
  });

  it('omits a state member that carries no data at all', () => {
    const copy = cloneRunState(
      envelope([{ id: 'relic-1', state: new Map([['fired', 1]]) }])
    );

    expect(
      Object.prototype.hasOwnProperty.call(copy.relics[0], 'state')
    ).toBe(false);
  });

  it('never invokes an accessor of the original', () => {
    let reads = 0;
    const hostile = {
      get fired(): number {
        reads += 1;

        return 1;
      },
      armed: true,
    };
    const copy = cloneRunState(envelope([{ id: 'relic-1', state: hostile }]));

    expect(reads).toBe(0);
    expect(copy.relics[0].state).toEqual({ armed: true });
  });
});

/* ===== 5. The store boundary the two compose into ===== */

/** An in-memory persistence port, so no test reaches Web Storage. */
function createPort(): RunStatePersistencePort & {
  readonly written: Map<OwnedStorageKey, string>;
} {
  const written = new Map<OwnedStorageKey, string>();

  return {
    written,

    readRaw(key: OwnedStorageKey): string | null {
      return written.get(key) ?? null;
    },

    readJson(key: OwnedStorageKey): unknown {
      const raw = written.get(key);

      return raw === undefined ? null : JSON.parse(raw);
    },

    writeJson(key: OwnedStorageKey, value: unknown): boolean {
      written.set(key, JSON.stringify(value));

      return true;
    },

    removeRaw(key: OwnedStorageKey): boolean {
      written.delete(key);

      return true;
    },
  };
}

describe('RunStateStore refuses an envelope it could not read back', () => {
  it('writes an envelope whose relic state is persistable', () => {
    const port = createPort();
    const store = new RunStateStore({ storage: port });

    expect(
      store.save(envelope([{ id: 'relic-1', charges: 1, state: { fired: 2 } }]))
    ).toBe(true);
    expect(port.written.has(RUN_STATE_KEY)).toBe(true);
  });

  it('refuses one carrying a value persistence would lose', () => {
    const port = createPort();
    const store = new RunStateStore({ storage: port });

    expect(
      store.save(envelope([{ id: 'relic-1', state: { at: new Date(0) } }]))
    ).toBe(false);
    expect(port.written.has(RUN_STATE_KEY)).toBe(false);
  });

  it('refuses one carrying a reserved member name', () => {
    const port = createPort();
    const store = new RunStateStore({ storage: port });

    expect(
      store.save(
        envelope([
          { id: 'relic-1', state: JSON.parse('{"__proto__":{"x":1}}') },
        ])
      )
    ).toBe(false);
    expect(port.written.has(RUN_STATE_KEY)).toBe(false);
  });

  it('refuses one carrying a cycle rather than throwing', () => {
    const port = createPort();
    const store = new RunStateStore({ storage: port });
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    expect(() =>
      store.save(envelope([{ id: 'relic-1', state: cyclic }]))
    ).not.toThrow();
    expect(port.written.has(RUN_STATE_KEY)).toBe(false);
  });

  it('loads back a stored envelope whose state is data', () => {
    const port = createPort();
    const store = new RunStateStore({ storage: port });
    const original = envelope([
      { id: 'relic-1', charges: 3, state: { fired: 1, log: ['a'] } },
    ]);

    expect(store.save(original)).toBe(true);

    const result = store.load();

    expect(result.verdict).toBe('current');
    expect(result.state).toEqual(original);
    expect(result.state?.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(result.state?.relics[0].state).not.toBe(original.relics[0].state);
  });

  it('falls back to fresh for a stored state outside the vocabulary', () => {
    const port = createPort();
    const store = new RunStateStore({ storage: port });
    const stored = JSON.stringify(envelope()).replace(
      '"relics":[]',
      '"relics":[{"id":"relic-1","state":{"__proto__":{"polluted":true}}}]'
    );

    // Written past the store, the way a tampered origin would carry it.
    port.written.set(RUN_STATE_KEY, stored);

    const result = store.load();

    expect(result.state).toBeNull();
    expect(result.outcome).toBe('fresh-fallback');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
