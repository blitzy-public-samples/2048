// Schema suite of src/run/run-state.ts: the nine-member run-state envelope,
// the board snapshot it wraps, its version classification, its cursor
// normalisation and its correlation-identifier derivation. AAP Contract 5
// (0.6.1.5), requirement R6, and the schema-versioning half of implicit
// requirement I5.
//
// `runCorrelationId()` is pinned byte-equal to `deriveCorrelationId()` of
// src/observability/logger.ts here, which is the only place the two separate
// implementations of that one algorithm are compared. src/run/ reaches no
// observability module, so nothing else can hold them together.
//
// Superseded constructs this suite is the named verification target for:
//   Tile.prototype.serialize         js/tile.js         L19-L27
//   Grid.prototype.serialize         js/grid.js         L102-L117
//   GameManager.prototype.serialize  js/game_manager.js L102-L110
//   keepPlaying                      js/game_manager.js L24-L27 assignment,
//                                    L31 read, L45 restore, L108 persist
//   fakeStorage                      js/local_storage_manager.js L1-L19
//
// Collected by the unit:dom-free project of vitest.config.ts, environment
// 'node'. Nothing here reads a document, a Web Storage global, a clock or
// randomness; nothing installs a mock, replaces a global or writes a
// snapshot artifact.
//
// Coverage boundaries this suite stays inside: end-to-end cursor resume is
// tests/unit/run/rng-cursor-persistence.test.ts, store behaviour is
// tests/unit/run/run-state-store.test.ts, the deep copy is
// tests/unit/run/run-state-cloning.test.ts, and the frozen best-score
// contract is tests/unit/storage/best-score.test.ts.
//
// Figures these assertions define the schema for: Figure 4 (Turn Data Flow)
// and Figure 7 (Seeded Determinism) of docs/architecture/data-flow.md.
//
// Decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createDefaultStageConfig,
  stageGoalForIndex,
} from '../../../src/config/stage-config';
import type { StageGoal } from '../../../src/config/stage-config';
import { Grid } from '../../../src/engine/grid';
import { Tile } from '../../../src/engine/tile';
import type {
  SerializedGameState,
  SerializedTile,
} from '../../../src/engine/types';
import type {
  PersistedRelic as RelicsPersistedRelic,
} from '../../../src/relics/relic-types';
import {
  MAX_RNG_CURSOR,
  MAX_RUN_SEED_LENGTH,
  RNG_STREAM_NAMES,
} from '../../../src/rng/rng-streams';
import type { RngCursorMap, StreamName } from '../../../src/rng/rng-streams';
import { deriveCorrelationId } from '../../../src/observability/logger';
import * as runStateModule from '../../../src/run/run-state';
import {
  MAX_PERSISTED_RELICS,
  MAX_SUPPORTED_BOARD_SIZE,
  NOOP_RUN_REPORTER,
  RUN_STATE_SCHEMA_VERSION,
  RUN_STATE_SCHEMA_VERSION_HISTORY,
  RUN_STATE_VERSION_POLICY,
  classifyRunStateVersion,
  createFreshRunState,
  describeRunStateProblems,
  isCurrentRunState,
  isPersistedRelicState,
  isRunStateShape,
  normalizeRngCursor,
  projectCurrentRunState,
  redactRunSummary,
  resolveRunStateVersionPolicy,
  runCorrelationId,
  summarizeRunState,
  summarizeRunStateForReport,
} from '../../../src/run/run-state';
import type {
  FreshRunStateInput,
  LegacyBoardSnapshot,
  PersistedRelic,
  RunReporter,
  RunState,
  RunStateVersionPolicy,
  RunStateVersionVerdict,
  RunSummary,
} from '../../../src/run/run-state';
import { MemoryStorage } from '../../../src/storage/memory-storage';
import {
  BEST_SCORE_KEY,
  OWNED_STORAGE_KEYS,
} from '../../../src/storage/storage-keys';
import { MERGE_PAIR_BOARD, copyBoard } from '../../fixtures/boards';

/* ===== Type-level assertion helpers ===== */

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
    ? true
    : false;

type Expect<T extends true> = T;

/**
 * `LegacyBoardSnapshot` is an alias of the engine's own snapshot declaration,
 * never a second declaration of the same members.
 */
const boardSnapshotAliasHolds: Expect<
  Equal<LegacyBoardSnapshot, SerializedGameState>
> = true;

/** The version verdict union carries five members and no sixth. */
const versionVerdictUnionIsExhaustive: Expect<
  Equal<
    RunStateVersionVerdict,
    'current' | 'older' | 'unknown' | 'absent' | 'malformed'
  >
> = true;

/**
 * The persisted relic triple is declared in src/run/run-state.ts and again in
 * src/relics/relic-types.ts. Divergence between the two is a type error here.
 */
const relicTripleIsIdentical: Expect<
  Equal<PersistedRelic, RelicsPersistedRelic>
> = true;

/** Assignability of the relics-side declaration to the run-side one. */
const runAcceptsRelicsTriple: PersistedRelic = {} as RelicsPersistedRelic;

/** Assignability of the run-side declaration to the relics-side one. */
const relicsAcceptsRunTriple: RelicsPersistedRelic = {} as PersistedRelic;

/* ===== Fixtures ===== */

/** The nine members Contract 5 fixes the envelope at. */
const ENVELOPE_MEMBERS: readonly string[] = [
  'schemaVersion',
  'runId',
  'seed',
  'rngCursor',
  'stageIndex',
  'stageGoal',
  'goalProgress',
  'relics',
  'board',
];

/** The five members of the wrapped snapshot, in persisted key order. */
const BOARD_MEMBERS: readonly string[] = [
  'grid',
  'score',
  'over',
  'won',
  'keepPlaying',
];

/** The five members of a run summary, sorted. */
const SUMMARY_MEMBERS: readonly string[] = [
  'relics',
  'runId',
  'score',
  'seed',
  'stageIndex',
];

/**
 * Every channel the injected report sink declares.
 *
 * `onWriteFailed` is the DIAGNOSTIC half of a refused write — the key, the
 * serialised size and the cause — and `onPersistenceStatusChanged` the
 * PLAYER-FACING half, reported on a change of status rather than per refused
 * write. Decision DL-RUNCTL-20.
 */
const REPORTER_CHANNELS: readonly string[] = [
  'onLoadCorrupted',
  'onVersionMigrated',
  'onBoardSizeReconciled',
  'onWriteFailed',
  'onPersistenceStatusChanged',
  'onRunStarted',
  'onStageAdvanced',
  'onRewardOffered',
  'onRewardDrawn',
  'onRunEnded',
];

/** The four named RNG substreams a cursor map covers. */
const CURSOR_STREAMS: readonly StreamName[] = RNG_STREAM_NAMES;

const STAGE_CONFIG = createDefaultStageConfig();

const INITIAL_STAGE_INDEX = 0;

const FIXTURE_SCORE = 24;

const ADDED_TILE_VALUE = 8;

/** Every verdict `classifyRunStateVersion()` reduces a payload to. */
const VERSION_VERDICTS: readonly RunStateVersionVerdict[] = [
  'current',
  'older',
  'unknown',
  'absent',
  'malformed',
];

/**
 * Builds the wrapped snapshot from live engine objects: a `Grid` rehydrated
 * from the merge-pair fixture's cell matrix, one further `Tile` placed into
 * it, and the three serialisation stages taken in order.
 *
 * @param score Score to record in the manager stage.
 * @returns The snapshot, in js/game_manager.js L102-L110's key order.
 */
function buildBoardSnapshot(
  score: number = FIXTURE_SCORE
): LegacyBoardSnapshot {
  const fixture = copyBoard(MERGE_PAIR_BOARD);
  const size = fixture.grid.size;

  // js/grid.js L21-L34: the serialised matrix is read as state[x][y].
  const grid = new Grid(size, fixture.grid.cells);

  grid.insertTile(new Tile({ x: size - 1, y: size - 1 }, ADDED_TILE_VALUE));

  return {
    grid: grid.serialize(),
    score,
    over: false,
    won: false,
    keepPlaying: false,
  };
}

/**
 * Builds the argument `createFreshRunState()` takes. The stage goal is read
 * from src/config/stage-config.ts.
 */
function buildInput(): FreshRunStateInput {
  return {
    runId: 'run-0001',
    seed: 'seed-42',
    rngCursor: {},
    stageIndex: INITIAL_STAGE_INDEX,
    stageGoal: stageGoalForIndex(INITIAL_STAGE_INDEX, STAGE_CONFIG),
    board: buildBoardSnapshot(),
  };
}

function buildEnvelope(): RunState {
  return createFreshRunState(buildInput());
}

/**
 * Builds an envelope holding `relics` in pickup order. `createFreshRunState()`
 * always returns an empty relic list; this replaces that member.
 */
function buildEnvelopeWithRelics(
  relics: readonly PersistedRelic[]
): RunState {
  return { ...buildEnvelope(), relics: relics.slice() };
}

/**
 * A JSON projection of a valid envelope, typed loosely so a member can be
 * deleted or replaced to build a hostile payload.
 */
function loosenEnvelope(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(buildEnvelope())) as Record<
    string,
    unknown
  >;
}

/** Every value a validator must reduce to a verdict without throwing. */
const HOSTILE_INPUTS: readonly unknown[] = [
  null,
  undefined,
  42,
  'text',
  true,
  [],
  [buildEnvelope()],
  {},
  Number.NaN,
];

/* ===== Storage teardown hygiene ===== */

/**
 * The store this suite owns and injects. The unit:dom-free project runs with
 * environment 'node' and exposes no Web Storage global.
 */
const storage = new MemoryStorage();

/**
 * Best score observed at the start of the current test. js/game_manager.js
 * L80-L82 promoted the value and js/local_storage_manager.js L61-L63 never
 * removed it.
 */
let bestScoreAtEntry: string | null | undefined = 'unread';

/**
 * Removes every key the product owns, then the best-score key by name.
 * Idempotent and tolerant of an already-clean store: `MemoryStorage`
 * `removeItem` of an absent key is a no-op. vitest.config.ts's setup file
 * registers an `afterEach` of its own.
 */
function clearOwnedKeys(): void {
  for (const key of OWNED_STORAGE_KEYS) {
    storage.removeItem(key);
  }

  storage.removeItem(BEST_SCORE_KEY);
}

beforeEach(() => {
  bestScoreAtEntry = storage.getItem(BEST_SCORE_KEY);
});

afterEach(clearOwnedKeys);

/* ===== 1. The nine-member envelope, and nothing more ===== */

describe('the envelope carries exactly the nine Contract 5 members', () => {
  it('carries all nine member names', () => {
    const keys = Object.keys(buildEnvelope());

    for (const member of ENVELOPE_MEMBERS) {
      expect(keys).toContain(member);
    }
  });

  it('carries no tenth member', () => {
    const keys = Object.keys(buildEnvelope());

    expect(keys).toHaveLength(ENVELOPE_MEMBERS.length);

    for (const key of keys) {
      expect(ENVELOPE_MEMBERS).toContain(key);
    }
  });

  it('carries the nine as a set, independently of declaration order', () => {
    const keys = Object.keys(buildEnvelope()).slice().sort();

    expect(keys).toEqual([...ENVELOPE_MEMBERS].sort());
  });

  it('names run state and board state separately, never flattened', () => {
    const state = buildEnvelope();

    expect(Object.keys(state)).not.toContain('score');
    expect(Object.keys(state)).not.toContain('over');
    expect(Object.keys(state)).not.toContain('won');
    expect(state.board.score).toBe(FIXTURE_SCORE);
  });
});

/* ==========================================================================
 * 1b. The optional tenth member: an unresolved reward round
 *
 * The envelope recorded the relics a run HELD and nothing about a round still
 * being chosen, so an offer drawn and not yet taken lived only in memory: a
 * reload lost the three cards and, because a cleared stage's goal is still met
 * on every later commit, resolved that stage's end a second time.
 *
 * Added as an OPTIONAL member at the SAME schema version, which is what makes it
 * additive: an envelope written before it validates unchanged, and one written
 * with it is read by a build that ignores it. The nine required members and
 * `RUN_STATE_SCHEMA_VERSION` are both untouched (Contract 5).
 * ========================================================================== */

/** An envelope carrying an unresolved round, which a fresh one never does. */
function buildEnvelopeWithPendingReward(
  offeredRelicIds: readonly string[] = ['alpha', 'beta', 'gamma'],
  stageIndex: number = INITIAL_STAGE_INDEX
): RunState {
  return {
    ...buildEnvelope(),
    pendingReward: { stageIndex, offeredRelicIds: offeredRelicIds.slice() },
  };
}

describe('the unresolved reward round member', () => {
  it('is absent from a fresh envelope, which has nothing pending', () => {
    const fresh = buildEnvelope();

    expect(fresh.pendingReward).toBeUndefined();
    expect(Object.keys(fresh)).not.toContain('pendingReward');
  });

  it('does not raise the schema version, because it is additive', () => {
    // An envelope written WITHOUT it is still current, so no migration is owed
    // and no prior save is invalidated.
    expect(buildEnvelopeWithPendingReward().schemaVersion).toBe(
      RUN_STATE_SCHEMA_VERSION
    );
    expect(isCurrentRunState(buildEnvelope())).toBe(true);
    expect(isCurrentRunState(buildEnvelopeWithPendingReward())).toBe(true);
  });

  it('validates as part of the envelope when it is well formed', () => {
    const state = buildEnvelopeWithPendingReward();

    expect(describeRunStateProblems(state)).toEqual([]);
    expect(isRunStateShape(state)).toBe(true);
  });

  it('survives a JSON round trip with its order intact', () => {
    const state = buildEnvelopeWithPendingReward(['one', 'two', 'three']);
    const revived = JSON.parse(JSON.stringify(state)) as RunState;

    // PRESENTATION ORDER IS THE POINT: the cards come back in the order they
    // were offered in, so the slot a player was about to press is the same slot.
    expect(revived.pendingReward?.offeredRelicIds).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(revived.pendingReward?.stageIndex).toBe(INITIAL_STAGE_INDEX);
    expect(isRunStateShape(revived)).toBe(true);
  });

  it('is carried by the write-side projection', () => {
    const projected = projectCurrentRunState(
      buildEnvelopeWithPendingReward(['x', 'y'])
    );

    expect(projected.pendingReward?.offeredRelicIds).toEqual(['x', 'y']);

    // COPIED, NOT ALIASED, exactly as every other member of the projection is.
    const source = buildEnvelopeWithPendingReward(['x', 'y']);
    const copy = projectCurrentRunState(source);

    expect(copy.pendingReward).not.toBe(source.pendingReward);
    expect(copy.pendingReward?.offeredRelicIds).not.toBe(
      source.pendingReward?.offeredRelicIds
    );
  });

  it('is dropped by the projection when there is nothing pending', () => {
    const projected = projectCurrentRunState(buildEnvelope());

    // Absent rather than `undefined`-valued, so an envelope with nothing pending
    // serialises to the same nine members it always did.
    expect(Object.keys(projected)).not.toContain('pendingReward');
  });

  it('refuses a round that is not an object', () => {
    for (const hostile of [null, 42, 'three cards', [], true]) {
      const payload = { ...loosenEnvelope(), pendingReward: hostile };

      expect(isRunStateShape(payload)).toBe(false);
      expect(describeRunStateProblems(payload).length).toBeGreaterThan(0);
    }
  });

  it('refuses a round whose stage index is not a counting number', () => {
    for (const hostile of [-1, 1.5, Number.NaN, '0', null]) {
      const payload = {
        ...loosenEnvelope(),
        pendingReward: { stageIndex: hostile, offeredRelicIds: ['a'] },
      };

      expect(isRunStateShape(payload)).toBe(false);
    }
  });

  it('refuses an empty, oversized, duplicated or non-string offer list', () => {
    const hostileLists: readonly unknown[] = [
      [],
      'a,b,c',
      ['a', 'a'],
      ['a', ''],
      ['a', 7],
      Array.from({ length: MAX_PERSISTED_RELICS + 1 }, (_, i) => `r${String(i)}`),
    ];

    for (const offeredRelicIds of hostileLists) {
      const payload = {
        ...loosenEnvelope(),
        pendingReward: { stageIndex: 0, offeredRelicIds },
      };

      expect(isRunStateShape(payload)).toBe(false);
    }
  });

  it('reduces every hostile value to a verdict without throwing', () => {
    for (const hostile of HOSTILE_INPUTS) {
      const payload = { ...loosenEnvelope(), pendingReward: hostile };

      expect(() => describeRunStateProblems(payload)).not.toThrow();
      expect(() => isRunStateShape(payload)).not.toThrow();
    }
  });
});

/* ===== 2. The schema version, and the history that decides older ===== */

describe('the schema version member', () => {
  it('stamps a fresh envelope with the current version', () => {
    expect(buildEnvelope().schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
  });

  it('is an integer, which is what a classification can compare', () => {
    expect(Number.isSafeInteger(RUN_STATE_SCHEMA_VERSION)).toBe(true);
  });
});

describe('the schema version history makes older decidable', () => {
  it('contains the current version', () => {
    expect(RUN_STATE_SCHEMA_VERSION_HISTORY).toContain(
      RUN_STATE_SCHEMA_VERSION
    );
  });

  it('is a non-empty list of safe integers', () => {
    expect(RUN_STATE_SCHEMA_VERSION_HISTORY.length).toBeGreaterThan(0);

    for (const version of RUN_STATE_SCHEMA_VERSION_HISTORY) {
      expect(Number.isSafeInteger(version)).toBe(true);
    }
  });

  it('ascends strictly, so no two entries compare equal', () => {
    const versions = [...RUN_STATE_SCHEMA_VERSION_HISTORY];

    for (let index = 1; index < versions.length; index += 1) {
      expect(versions[index]).toBeGreaterThan(versions[index - 1]);
    }
  });

  it('ends at the current version, so nothing recorded is newer', () => {
    const highest = Math.max(...RUN_STATE_SCHEMA_VERSION_HISTORY);

    expect(highest).toBe(RUN_STATE_SCHEMA_VERSION);
  });
});

/* ===== 3. The JSON round trip of the whole envelope ===== */

describe('the whole envelope survives a JSON round trip', () => {
  it('parses back deep-equal to the original', () => {
    const state = buildEnvelope();
    const restored = JSON.parse(JSON.stringify(state)) as RunState;

    expect(restored).toEqual(state);
  });

  it('parses back byte-for-byte, so no member order moves', () => {
    const state = buildEnvelope();
    const restored = JSON.parse(JSON.stringify(state)) as RunState;

    expect(JSON.stringify(restored)).toBe(JSON.stringify(state));
  });

  it('loses no member, which JSON would do for a function or undefined',
    () => {
      const state = buildEnvelope();
      const restored = JSON.parse(JSON.stringify(state)) as RunState;

      expect(Object.keys(restored).sort()).toEqual(
        Object.keys(state).sort()
      );
    });

  it('carries the stage goal through with both members intact', () => {
    const state = buildEnvelope();
    const restored = JSON.parse(JSON.stringify(state)) as RunState;
    const goal: StageGoal = restored.stageGoal;

    expect(Object.keys(goal).sort()).toEqual(['kind', 'target']);
    expect(goal.kind).toBe(state.stageGoal.kind);
    expect(goal.target).toBe(state.stageGoal.target);
  });

  it('carries a stage goal of plain data, holding no function member', () => {
    const goal = buildEnvelope().stageGoal as unknown as Record<
      string,
      unknown
    >;

    for (const value of Object.values(goal)) {
      expect(typeof value).not.toBe('function');
    }
  });

  it('carries the run seed and the run identifier verbatim', () => {
    const input = buildInput();
    const restored = JSON.parse(
      JSON.stringify(createFreshRunState(input))
    ) as RunState;

    expect(restored.seed).toBe(input.seed);
    expect(restored.runId).toBe(input.runId);
  });

  it('carries every cursor count through as a finite number', () => {
    const restored = JSON.parse(
      JSON.stringify(buildEnvelope())
    ) as RunState;

    for (const name of RNG_STREAM_NAMES) {
      expect(Number.isFinite(restored.rngCursor[name])).toBe(true);
    }
  });
});

/* ===== 4. The relics member as persisted triples ===== */

describe('the relics member is a list of persisted relic triples', () => {
  it('is empty on a fresh envelope', () => {
    expect(buildEnvelope().relics).toEqual([]);
  });

  it('accepts a triple carrying identity, charges and state', () => {
    const relic: PersistedRelic = {
      id: 'gilded-spawn',
      charges: 3,
      state: { fired: 1 },
    };
    const state = buildEnvelopeWithRelics([relic]);

    expect(isRunStateShape(state)).toBe(true);
    expect(state.relics[0]).toEqual(relic);
  });

  it('accepts a triple with charges and state both absent', () => {
    const relic: PersistedRelic = { id: 'plain-relic' };
    const state = buildEnvelopeWithRelics([relic]);

    expect(isRunStateShape(state)).toBe(true);
    expect(Object.keys(state.relics[0])).toEqual(['id']);
  });

  it('accepts a triple whose charge budget is exhausted at zero', () => {
    const state = buildEnvelopeWithRelics([{ id: 'spent', charges: 0 }]);

    expect(isRunStateShape(state)).toBe(true);
    expect(state.relics[0].charges).toBe(0);
  });

  it('preserves pickup order, which is hook dispatch order', () => {
    const ids = ['first', 'second', 'third'];
    const state = buildEnvelopeWithRelics(ids.map((id) => ({ id })));

    expect(state.relics.map((relic) => relic.id)).toEqual(ids);
  });

  it('round-trips a triple whose optional members are absent', () => {
    const state = buildEnvelopeWithRelics([{ id: 'plain-relic' }]);
    const restored = JSON.parse(JSON.stringify(state)) as RunState;

    expect(JSON.stringify(restored.relics)).toBe(
      JSON.stringify(state.relics)
    );
  });

  it('refuses a list longer than the persisted relic bound', () => {
    const overflow: PersistedRelic[] = [];

    for (let index = 0; index <= MAX_PERSISTED_RELICS; index += 1) {
      overflow.push({ id: `relic-${index}` });
    }

    const state = buildEnvelopeWithRelics(overflow);

    expect(isRunStateShape(state)).toBe(false);
    expect(
      describeRunStateProblems(state).some((problem) =>
        problem.startsWith('relics')
      )
    ).toBe(true);
  });
});

/* ===== 5. The board member wraps the snapshot verbatim ===== */

/**
 * Collects every serialised tile of a snapshot, column by column.
 *
 * @param board Snapshot to walk.
 * @returns The occupied cells, x-outer then y-inner.
 */
function occupiedCells(board: LegacyBoardSnapshot): SerializedTile[] {
  const tiles: SerializedTile[] = [];

  for (const column of board.grid.cells) {
    for (const cell of column) {
      if (cell !== null) {
        tiles.push(cell);
      }
    }
  }

  return tiles;
}

describe('the board member wraps the pre-migration snapshot verbatim', () => {
  it('is a type alias of the engine snapshot, never a redeclaration', () => {
    expect(boardSnapshotAliasHolds).toBe(true);
  });

  it('unwraps byte-for-byte identical after a wrap and a round trip', () => {
    const board = buildBoardSnapshot();
    const state = createFreshRunState({ ...buildInput(), board });
    const restored = JSON.parse(JSON.stringify(state)) as RunState;

    expect(JSON.stringify(restored.board)).toBe(JSON.stringify(board));
  });

  it('unwraps deep-equal after a wrap and a round trip', () => {
    const board = buildBoardSnapshot();
    const state = createFreshRunState({ ...buildInput(), board });
    const restored = JSON.parse(JSON.stringify(state)) as RunState;

    expect(restored.board).toEqual(board);
  });

  it('is wrapped rather than reshaped, so the snapshot reaches it whole',
    () => {
      const board = buildBoardSnapshot();
      const state = createFreshRunState({ ...buildInput(), board });

      expect(state.board).toBe(board);
    });

  it('accepts the engine grid serialisation with no cast', () => {
    const board = buildBoardSnapshot();

    expect(occupiedCells(board).length).toBeGreaterThan(0);
    expect(isRunStateShape(createFreshRunState({ ...buildInput(), board })))
      .toBe(true);
  });
});


/* ===== 6. The three stages of the wrapped projection ===== */

describe('the tile stage of the wrapped snapshot', () => {
  // js/tile.js L19-L27
  it('serialises a tile as position then value, in that key order', () => {
    for (const tile of occupiedCells(buildBoardSnapshot())) {
      expect(Object.keys(tile)).toEqual(['position', 'value']);
    }
  });

  it('nests the coordinates under position as x then y', () => {
    for (const tile of occupiedCells(buildBoardSnapshot())) {
      expect(Object.keys(tile.position)).toEqual(['x', 'y']);
      expect(Number.isSafeInteger(tile.position.x)).toBe(true);
      expect(Number.isSafeInteger(tile.position.y)).toBe(true);
    }
  });

  it('excludes the animation state previousPosition and mergedFrom', () => {
    for (const tile of occupiedCells(buildBoardSnapshot())) {
      expect(Object.keys(tile)).not.toContain('previousPosition');
      expect(Object.keys(tile)).not.toContain('mergedFrom');
    }
  });

  it('keeps position before value through the round trip', () => {
    const board = buildBoardSnapshot();
    const restored = JSON.parse(JSON.stringify(board)) as LegacyBoardSnapshot;

    for (const tile of occupiedCells(restored)) {
      expect(Object.keys(tile)).toEqual(['position', 'value']);
    }
  });

  it('carries the tile placed through the engine at its own coordinates',
    () => {
      const board = buildBoardSnapshot();
      const edge = board.grid.size - 1;
      const placed = occupiedCells(board).find(
        (tile) => tile.value === ADDED_TILE_VALUE
      );

      expect(placed).toEqual({
        position: { x: edge, y: edge },
        value: ADDED_TILE_VALUE,
      });
    });
});

describe('the grid stage of the wrapped snapshot', () => {
  // js/grid.js L102-L117
  it('serialises the grid as size then cells, in that key order', () => {
    expect(Object.keys(buildBoardSnapshot().grid)).toEqual(['size', 'cells']);
  });

  it('builds the matrix x-outer and y-inner, square at the declared size',
    () => {
      const grid = buildBoardSnapshot().grid;

      expect(grid.cells).toHaveLength(grid.size);

      for (const column of grid.cells) {
        expect(column).toHaveLength(grid.size);
      }
    });

  it('declares a size within the supported board bound', () => {
    const size = buildBoardSnapshot().grid.size;

    expect(size).toBeGreaterThanOrEqual(1);
    expect(size).toBeLessThanOrEqual(MAX_SUPPORTED_BOARD_SIZE);
  });

  it('holds an empty cell as literal null, not undefined', () => {
    const grid = buildBoardSnapshot().grid;
    const empties = grid.cells
      .flat()
      .filter((cell) => cell === null);

    expect(empties.length).toBeGreaterThan(0);

    for (const cell of empties) {
      expect(cell).toBeNull();
      expect(cell).not.toBeUndefined();
    }
  });

  it('holds an empty cell as a present entry, never a sparse hole', () => {
    const grid = buildBoardSnapshot().grid;

    for (const column of grid.cells) {
      for (let y = 0; y < grid.size; y += 1) {
        expect(Object.prototype.hasOwnProperty.call(column, y)).toBe(true);
      }
    }
  });

  it('keeps an empty cell as literal null after the round trip', () => {
    const board = buildBoardSnapshot();
    const restored = JSON.parse(JSON.stringify(board)) as LegacyBoardSnapshot;
    let emptyCount = 0;

    for (const column of restored.grid.cells) {
      for (const cell of column) {
        if (cell === null) {
          emptyCount += 1;
        }
      }
    }

    expect(emptyCount).toBe(
      board.grid.cells.flat().filter((cell) => cell === null).length
    );
    expect(emptyCount).toBeGreaterThan(0);
  });
});

describe('the manager stage of the wrapped snapshot', () => {
  // js/game_manager.js L102-L110
  it('serialises the board as grid, score, over, won, keepPlaying', () => {
    expect(Object.keys(buildBoardSnapshot())).toEqual(BOARD_MEMBERS);
  });

  it('keeps that key order through the round trip', () => {
    const restored = JSON.parse(
      JSON.stringify(buildBoardSnapshot())
    ) as LegacyBoardSnapshot;

    expect(Object.keys(restored)).toEqual(BOARD_MEMBERS);
  });

  it('carries score as a finite number and the three flags as booleans',
    () => {
      const board = buildBoardSnapshot();

      expect(Number.isFinite(board.score)).toBe(true);
      expect(typeof board.over).toBe('boolean');
      expect(typeof board.won).toBe('boolean');
      expect(typeof board.keepPlaying).toBe('boolean');
    });
});

/* ===== 7. The frozen persisted member name keepPlaying ===== */

/** Names the persisted flag must not have moved to. */
const RENAMED_FLAG_VARIANTS: readonly string[] = [
  'continuedPlay',
  'continueAfterWin',
  'keepGoing',
  'keep_playing',
  'playingOn',
];

describe('the persisted member name keepPlaying is frozen', () => {
  // js/game_manager.js L24-L27 assignment, L31 read, L45 restore, L108 persist
  it('is an own property of the wrapped snapshot', () => {
    const board = buildEnvelope().board;

    expect(Object.prototype.hasOwnProperty.call(board, 'keepPlaying')).toBe(
      true
    );
  });

  it('holds a boolean', () => {
    expect(typeof buildEnvelope().board.keepPlaying).toBe('boolean');
  });

  it('survives the round trip under the same name', () => {
    const state = buildEnvelope();
    const restored = JSON.parse(JSON.stringify(state)) as RunState;

    expect(Object.keys(restored.board)).toContain('keepPlaying');
    expect(restored.board.keepPlaying).toBe(state.board.keepPlaying);
  });

  it('appears under no renamed variant in the persisted board', () => {
    const keys = Object.keys(buildEnvelope().board);

    for (const variant of RENAMED_FLAG_VARIANTS) {
      expect(keys).not.toContain(variant);
    }
  });

  it('is the name the envelope validator itself reads', () => {
    const payload = loosenEnvelope();
    const board = payload.board as Record<string, unknown>;

    board.continuedPlay = board.keepPlaying;
    delete board.keepPlaying;

    expect(isRunStateShape(payload)).toBe(false);
    expect(describeRunStateProblems(payload)).toContain(
      'board.keepPlaying is not a boolean'
    );
  });

  it('owns the persisted side alone, naming no input event', () => {
    const state = buildEnvelope();

    expect(Object.keys(state)).not.toContain('keepPlaying');
    expect(Object.keys(state.board)).toContain('keepPlaying');
  });
});


/* ===== 8. isRunStateShape ===== */

describe('isRunStateShape accepts a structurally complete envelope', () => {
  it('accepts a fresh envelope', () => {
    expect(isRunStateShape(buildEnvelope())).toBe(true);
  });

  it('accepts one holding relics in pickup order', () => {
    const state = buildEnvelopeWithRelics([
      { id: 'first', charges: 2 },
      { id: 'second', state: { seen: true } },
    ]);

    expect(isRunStateShape(state)).toBe(true);
  });

  it('accepts one restored from JSON', () => {
    const restored = JSON.parse(JSON.stringify(buildEnvelope())) as unknown;

    expect(isRunStateShape(restored)).toBe(true);
  });

  it('agrees with describeRunStateProblems on the same input', () => {
    const inputs: readonly unknown[] = [
      buildEnvelope(),
      ...HOSTILE_INPUTS,
      loosenEnvelope(),
    ];

    for (const input of inputs) {
      expect(isRunStateShape(input)).toBe(
        describeRunStateProblems(input).length === 0
      );
    }
  });
});

describe('isRunStateShape refuses a broken payload without throwing', () => {
  it('refuses every non-envelope value it is handed', () => {
    for (const input of HOSTILE_INPUTS) {
      expect(() => isRunStateShape(input)).not.toThrow();
      expect(isRunStateShape(input)).toBe(false);
    }
  });

  it('refuses an envelope missing any one of the nine members', () => {
    for (const member of ENVELOPE_MEMBERS) {
      const payload = loosenEnvelope();

      delete payload[member];

      expect(isRunStateShape(payload)).toBe(false);
    }
  });

  it('refuses a member holding the wrong primitive type', () => {
    const wrongTypes: Readonly<Record<string, unknown>> = {
      schemaVersion: 'one',
      runId: 7,
      seed: null,
      rngCursor: 'none',
      stageIndex: '0',
      stageGoal: 'highest-tile',
      goalProgress: '0',
      relics: { first: { id: 'x' } },
      board: 'empty',
    };

    for (const member of Object.keys(wrongTypes)) {
      const payload = loosenEnvelope();

      payload[member] = wrongTypes[member];

      expect(isRunStateShape(payload)).toBe(false);
    }
  });

  it('refuses a board that is present but structurally wrong', () => {
    const payload = loosenEnvelope();
    const board = payload.board as Record<string, unknown>;
    const grid = board.grid as Record<string, unknown>;

    grid.cells = 'not-a-matrix';

    expect(isRunStateShape(payload)).toBe(false);
  });

  it('refuses a goalProgress outside the closed unit interval', () => {
    for (const value of [-0.5, 1.5, Number.NaN]) {
      const payload = loosenEnvelope();

      payload.goalProgress = value;

      expect(isRunStateShape(payload)).toBe(false);
    }
  });
});

/* ===== 9. describeRunStateProblems ===== */

describe('describeRunStateProblems reports nothing for a valid envelope',
  () => {
    it('returns an empty list for a fresh envelope', () => {
      expect(describeRunStateProblems(buildEnvelope())).toEqual([]);
    });

    it('returns an empty list for one holding relics', () => {
      const state = buildEnvelopeWithRelics([{ id: 'held', charges: 1 }]);

      expect(describeRunStateProblems(state)).toEqual([]);
    });

    it('returns a fresh list on every call', () => {
      const first = describeRunStateProblems(buildEnvelope());
      const second = describeRunStateProblems(buildEnvelope());

      expect(first).not.toBe(second);
    });
  });

describe('describeRunStateProblems names the offending field', () => {
  it('names each of the nine members when that member is missing', () => {
    for (const member of ENVELOPE_MEMBERS) {
      const payload = loosenEnvelope();

      delete payload[member];

      const problems = describeRunStateProblems(payload);

      expect(problems.length).toBeGreaterThan(0);
      expect(problems.some((problem) => problem.startsWith(member))).toBe(
        true
      );
    }
  });

  it('names the whole value when it is not an object at all', () => {
    for (const input of [null, undefined, 42, 'text', true, []]) {
      expect(describeRunStateProblems(input)).toEqual([
        'run state is not an object',
      ]);
    }
  });

  it('names schemaVersion when it is not an integer', () => {
    const payload = loosenEnvelope();

    payload.schemaVersion = 1.5;

    expect(describeRunStateProblems(payload)).toContain(
      'schemaVersion is not an integer'
    );
  });

  it('names runId when it is not a string', () => {
    const payload = loosenEnvelope();

    payload.runId = 7;

    expect(describeRunStateProblems(payload)).toContain(
      'runId is not a string'
    );
  });

  it('names seed when it is not a string', () => {
    const payload = loosenEnvelope();

    payload.seed = null;

    expect(describeRunStateProblems(payload)).toContain(
      'seed is not a string'
    );
  });

  it('names rngCursor when it is not an object', () => {
    const payload = loosenEnvelope();

    payload.rngCursor = 'none';

    expect(describeRunStateProblems(payload)).toContain(
      'rngCursor is not an object'
    );
  });

  it('names the substream whose recorded count is unusable', () => {
    const payload = loosenEnvelope();
    const cursor = payload.rngCursor as Record<string, unknown>;

    cursor['relic-draw'] = -1;

    expect(
      describeRunStateProblems(payload).some((problem) =>
        problem.startsWith('rngCursor.relic-draw')
      )
    ).toBe(true);
  });

  it('names stageIndex when it holds a string', () => {
    const payload = loosenEnvelope();

    payload.stageIndex = '0';

    expect(describeRunStateProblems(payload)).toContain(
      'stageIndex is not a non-negative integer'
    );
  });

  it('names stageGoal.kind when the kind is not a declared one', () => {
    const payload = loosenEnvelope();
    const goal = payload.stageGoal as Record<string, unknown>;

    goal.kind = 'nonesuch';

    expect(describeRunStateProblems(payload)).toContain(
      'stageGoal.kind is not a declared stage goal kind'
    );
  });

  it('names stageGoal.target when it is not a finite number', () => {
    const payload = loosenEnvelope();
    const goal = payload.stageGoal as Record<string, unknown>;

    goal.target = 'far';

    expect(describeRunStateProblems(payload)).toContain(
      'stageGoal.target is not a finite number'
    );
  });

  it('names goalProgress when it is outside the unit interval', () => {
    const payload = loosenEnvelope();

    payload.goalProgress = 2;

    expect(describeRunStateProblems(payload)).toContain(
      'goalProgress is not a fraction within [0, 1]'
    );
  });

  it('names relics when it is not an array', () => {
    const payload = loosenEnvelope();

    payload.relics = { first: { id: 'x' } };

    expect(describeRunStateProblems(payload)).toContain(
      'relics is not an array'
    );
  });

  it('names the pickup index of the offending relic', () => {
    const payload = loosenEnvelope();

    payload.relics = [{ id: 'ok' }, { id: 5 }];

    expect(describeRunStateProblems(payload)).toContain(
      'relics[1].id is not a string'
    );
  });

  it('names board.grid.cells when the matrix is not an array', () => {
    const payload = loosenEnvelope();
    const board = payload.board as Record<string, unknown>;
    const grid = board.grid as Record<string, unknown>;

    grid.cells = 'not-a-matrix';

    expect(describeRunStateProblems(payload)).toContain(
      'board.grid.cells is not an array'
    );
  });

  it('names board.grid.size when the edge is outside the bound', () => {
    const payload = loosenEnvelope();
    const board = payload.board as Record<string, unknown>;
    const grid = board.grid as Record<string, unknown>;

    grid.size = MAX_SUPPORTED_BOARD_SIZE + 1;

    expect(
      describeRunStateProblems(payload).some((problem) =>
        problem.startsWith('board.grid.size')
      )
    ).toBe(true);
  });

  it('names board.score when it is not a finite number', () => {
    const payload = loosenEnvelope();
    const board = payload.board as Record<string, unknown>;

    board.score = 'many';

    expect(describeRunStateProblems(payload)).toContain(
      'board.score is not a finite number'
    );
  });
});

describe('describeRunStateProblems never throws', () => {
  it('returns a list for every non-envelope value it is handed', () => {
    for (const input of HOSTILE_INPUTS) {
      expect(() => describeRunStateProblems(input)).not.toThrow();
      expect(describeRunStateProblems(input).length).toBeGreaterThan(0);
    }
  });

  it('returns a list for wrongness nested at every level at once', () => {
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    const payload: Record<string, unknown> = {
      schemaVersion: 'one',
      runId: 7,
      seed: null,
      rngCursor: { 'spawn-value': 'many' },
      stageIndex: -1,
      stageGoal: { kind: 'nonesuch', target: 'far' },
      goalProgress: 2,
      relics: [{ id: 5, charges: -1, state: cyclic }],
      board: {
        grid: { size: 0, cells: [[{ position: null, value: 'two' }]] },
        score: Number.NaN,
        over: 'no',
        won: 1,
        keepPlaying: null,
      },
    };

    expect(() => describeRunStateProblems(payload)).not.toThrow();
    expect(describeRunStateProblems(payload).length).toBeGreaterThan(0);
  });

  it('reports an unreadable member rather than letting its accessor throw',
    () => {
      const payload = loosenEnvelope();

      Object.defineProperty(payload, 'stageIndex', {
        get(): never {
          throw new Error('member refused');
        },
        configurable: true,
        enumerable: true,
      });

      expect(() => describeRunStateProblems(payload)).not.toThrow();
      expect(describeRunStateProblems(payload)).toContain(
        'stageIndex is not readable'
      );
    });
});


/* ===== 10. classifyRunStateVersion ===== */

describe('classifyRunStateVersion reports current for this build', () => {
  it('reports current for a fresh envelope', () => {
    expect(classifyRunStateVersion(buildEnvelope())).toBe('current');
  });

  it('reports current for a payload carrying only the current version', () => {
    expect(
      classifyRunStateVersion({ schemaVersion: RUN_STATE_SCHEMA_VERSION })
    ).toBe('current');
  });
});

describe('classifyRunStateVersion separates older from unknown', () => {
  it('records no version below the current one, so none classifies older',
    () => {
      const recordedOlder = RUN_STATE_SCHEMA_VERSION_HISTORY.filter(
        (version) => version < RUN_STATE_SCHEMA_VERSION
      );

      // Stated as an EQUALITY rather than driven as a loop. The shipped history
      // holds one entry, so a loop over this set would iterate zero times and
      // assert nothing while reading as coverage of the 'older' branch. The
      // branch is exercised for real against an injected policy in section 23.
      expect(recordedOlder).toEqual([]);

      for (const version of recordedOlder) {
        expect(classifyRunStateVersion({ schemaVersion: version })).toBe(
          'older'
        );
      }
    });

  it('reports older for a version an injected policy places below current',
    () => {
      // The same claim the empty set above cannot make, made against a policy
      // naming a genuine prior version.
      const policy: RunStateVersionPolicy = {
        current: RUN_STATE_SCHEMA_VERSION + 1,
        history: [RUN_STATE_SCHEMA_VERSION, RUN_STATE_SCHEMA_VERSION + 1],
      };
      const older = policy.history.filter(
        (version) => version < policy.current
      );

      expect(older.length).toBeGreaterThan(0);

      for (const version of older) {
        expect(
          classifyRunStateVersion({ schemaVersion: version }, policy)
        ).toBe('older');
      }
    });

  it('reports unknown for an integer above the current version', () => {
    for (const offset of [1, 2, 99]) {
      expect(
        classifyRunStateVersion({
          schemaVersion: RUN_STATE_SCHEMA_VERSION + offset,
        })
      ).toBe('unknown');
    }
  });

  it('reports unknown for a lower integer the history does not record', () => {
    const unrecorded = [0, -1, -99].filter(
      (version) => !RUN_STATE_SCHEMA_VERSION_HISTORY.includes(version)
    );

    expect(unrecorded.length).toBeGreaterThan(0);

    for (const version of unrecorded) {
      expect(classifyRunStateVersion({ schemaVersion: version })).toBe(
        'unknown'
      );
    }
  });
});

describe('classifyRunStateVersion separates absent from malformed', () => {
  it('reports absent when there is no stored value at all', () => {
    expect(classifyRunStateVersion(null)).toBe('absent');
    expect(classifyRunStateVersion(undefined)).toBe('absent');
  });

  it('reports absent for a payload written before the member existed', () => {
    const payload = loosenEnvelope();

    delete payload.schemaVersion;

    expect(classifyRunStateVersion(payload)).toBe('absent');
  });

  it('reports malformed for a version present but not an integer', () => {
    const wrong: readonly unknown[] = [
      '1',
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      null,
      true,
      {},
      [],
    ];

    for (const version of wrong) {
      expect(classifyRunStateVersion({ schemaVersion: version })).toBe(
        'malformed'
      );
    }
  });

  it('reports malformed for a payload that is not a plain object', () => {
    for (const payload of [42, 'text', true, [], [buildEnvelope()]]) {
      expect(classifyRunStateVersion(payload)).toBe('malformed');
    }
  });

  it('reports malformed rather than letting an accessor throw', () => {
    const payload: Record<string, unknown> = {};

    Object.defineProperty(payload, 'schemaVersion', {
      get(): never {
        throw new Error('member refused');
      },
      configurable: true,
      enumerable: true,
    });

    expect(() => classifyRunStateVersion(payload)).not.toThrow();
    expect(classifyRunStateVersion(payload)).toBe('malformed');
  });
});

describe('classifyRunStateVersion is total over the five-way union', () => {
  it('declares five verdicts and no sixth', () => {
    expect(versionVerdictUnionIsExhaustive).toBe(true);
    expect(VERSION_VERDICTS).toHaveLength(5);
    expect(new Set(VERSION_VERDICTS).size).toBe(VERSION_VERDICTS.length);
  });

  it('returns one declared verdict for every input, never throwing', () => {
    const inputs: readonly unknown[] = [
      ...HOSTILE_INPUTS,
      buildEnvelope(),
      loosenEnvelope(),
      { schemaVersion: RUN_STATE_SCHEMA_VERSION },
      { schemaVersion: RUN_STATE_SCHEMA_VERSION + 1 },
      { schemaVersion: '1' },
    ];

    for (const input of inputs) {
      expect(() => classifyRunStateVersion(input)).not.toThrow();
      expect(VERSION_VERDICTS).toContain(classifyRunStateVersion(input));
    }
  });

  it('reaches every verdict the recorded history makes reachable', () => {
    const recordedOlder = RUN_STATE_SCHEMA_VERSION_HISTORY.filter(
      (version) => version < RUN_STATE_SCHEMA_VERSION
    );
    const probes: readonly unknown[] = [
      { schemaVersion: RUN_STATE_SCHEMA_VERSION },
      { schemaVersion: RUN_STATE_SCHEMA_VERSION + 1 },
      null,
      'text',
      ...recordedOlder.map((version) => ({ schemaVersion: version })),
    ];
    const expected: Set<RunStateVersionVerdict> = new Set([
      'current',
      'unknown',
      'absent',
      'malformed',
    ]);

    if (recordedOlder.length > 0) {
      expected.add('older');
    }

    const reached = new Set(
      probes.map((probe) => classifyRunStateVersion(probe))
    );

    expect([...reached].sort()).toEqual([...expected].sort());
  });
});

/* ===== 11. normalizeRngCursor, the pure-validator input matrix ===== */

/** Every value the cursor normaliser must reduce to a total map. */
const CURSOR_INPUTS: readonly unknown[] = [
  undefined,
  null,
  {},
  { 'spawn-value': 4 },
  { 'spawn-value': 4, 'relic-draw': 9 },
  { 'spawn-value': 4, nonesuch: 9 },
  { 'spawn-value': -5 },
  { 'spawn-value': 2.5 },
  { 'spawn-value': Number.NaN },
  { 'spawn-value': Number.POSITIVE_INFINITY },
  { 'spawn-value': Number.NEGATIVE_INFINITY },
  { 'spawn-value': '7' },
  { 'spawn-value': null },
  { 'spawn-value': true },
  { 'spawn-value': {} },
  { 'spawn-value': [] },
  { 'spawn-value': MAX_RNG_CURSOR + 1 },
  42,
  'text',
  true,
  [],
];

describe('normalizeRngCursor always returns a total cursor map', () => {
  it('covers all four substream names for every input', () => {
    for (const input of CURSOR_INPUTS) {
      const cursor: RngCursorMap = normalizeRngCursor(input);

      expect(Object.keys(cursor).sort()).toEqual(
        [...CURSOR_STREAMS].sort()
      );
    }
  });

  it('never throws for any input', () => {
    for (const input of CURSOR_INPUTS) {
      expect(() => normalizeRngCursor(input)).not.toThrow();
    }
  });

  it('carries the substream names in the order the tuple declares', () => {
    expect(Object.keys(normalizeRngCursor(undefined))).toEqual([
      ...CURSOR_STREAMS,
    ]);
  });

  it('yields a non-negative safe integer for every substream', () => {
    for (const input of CURSOR_INPUTS) {
      const cursor = normalizeRngCursor(input);

      for (const name of CURSOR_STREAMS) {
        expect(Number.isSafeInteger(cursor[name])).toBe(true);
        expect(cursor[name]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('returns a fresh map on every call', () => {
    const first = normalizeRngCursor(undefined);
    const second = normalizeRngCursor(undefined);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

describe('normalizeRngCursor fills and completes a recorded map', () => {
  it('fills an absent, null or empty map with zero throughout', () => {
    for (const input of [undefined, null, {}]) {
      const cursor = normalizeRngCursor(input);

      for (const name of CURSOR_STREAMS) {
        expect(cursor[name]).toBe(0);
      }
    }
  });

  it('completes a partial map, keeping the counts it does record', () => {
    const cursor = normalizeRngCursor({
      'spawn-value': 7,
      'relic-draw': 3,
    });

    expect(cursor['spawn-value']).toBe(7);
    expect(cursor['relic-draw']).toBe(3);
    expect(cursor['spawn-position']).toBe(0);
    expect(cursor['rarity-weight']).toBe(0);
  });

  it('drops a member no substream is named by', () => {
    const cursor = normalizeRngCursor({ 'spawn-value': 4, nonesuch: 9 });

    expect(Object.keys(cursor)).not.toContain('nonesuch');
    expect(cursor['spawn-value']).toBe(4);
  });

  it('keeps a count already at the resumable bound', () => {
    const cursor = normalizeRngCursor({ 'spawn-value': MAX_RNG_CURSOR });

    expect(cursor['spawn-value']).toBe(MAX_RNG_CURSOR);
  });
});

describe('normalizeRngCursor rejects an unusable count to zero', () => {
  it('rejects a negative count', () => {
    expect(normalizeRngCursor({ 'spawn-value': -5 })['spawn-value']).toBe(0);
  });

  it('rejects a non-integer count', () => {
    for (const count of [2.5, 0.1, -0.5]) {
      expect(normalizeRngCursor({ 'spawn-value': count })['spawn-value'])
        .toBe(0);
    }
  });

  it('rejects a non-finite count', () => {
    const nonFinite = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const count of nonFinite) {
      expect(normalizeRngCursor({ 'spawn-value': count })['spawn-value'])
        .toBe(0);
    }
  });

  it('rejects a count that is not a number at all', () => {
    for (const count of ['7', true, null, undefined, {}, []]) {
      expect(normalizeRngCursor({ 'spawn-value': count })['spawn-value'])
        .toBe(0);
    }
  });

  it('rejects a count beyond the resumable bound', () => {
    const beyond = normalizeRngCursor({
      'spawn-value': MAX_RNG_CURSOR + 1,
    });

    expect(beyond['spawn-value']).toBe(0);
  });

  it('keeps zero as zero and collapses negative zero to positive', () => {
    const zeroed = normalizeRngCursor({
      'spawn-value': 0,
      'relic-draw': -0,
    });

    expect(Object.is(zeroed['spawn-value'], 0)).toBe(true);
    expect(Object.is(zeroed['relic-draw'], 0)).toBe(true);
  });

  it('rejects a count whose accessor throws', () => {
    const source: Record<string, unknown> = {};

    Object.defineProperty(source, 'spawn-value', {
      get(): never {
        throw new Error('member refused');
      },
      configurable: true,
      enumerable: true,
    });

    expect(() => normalizeRngCursor(source)).not.toThrow();
    expect(normalizeRngCursor(source)['spawn-value']).toBe(0);
  });
});


/* ===== 12. createFreshRunState ===== */

describe('createFreshRunState returns a distinct envelope per call', () => {
  it('returns a new object on every call', () => {
    const first = buildEnvelope();
    const second = buildEnvelope();

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });

  it('leaves a later call unaffected by a mutation of an earlier one', () => {
    const first = buildEnvelope();
    const mutableFirst = first as unknown as Record<string, unknown>;
    const mutableBoard = first.board as unknown as Record<string, unknown>;

    mutableFirst.stageIndex = 99;
    mutableFirst.goalProgress = 1;
    mutableBoard.score = 999999;

    const second = buildEnvelope();

    expect(second.stageIndex).toBe(INITIAL_STAGE_INDEX);
    expect(second.goalProgress).toBe(0);
    expect(second.board.score).toBe(FIXTURE_SCORE);
  });

  it('leaves a later cursor map unaffected by a mutation of an earlier one',
    () => {
      const first = buildEnvelope();
      const mutableCursor = first.rngCursor as Record<StreamName, number>;

      mutableCursor['spawn-value'] = 500;

      expect(buildEnvelope().rngCursor['spawn-value']).toBe(0);
    });

  it('leaves a later relic list unaffected by a mutation of an earlier one',
    () => {
      const first = buildEnvelope();
      const mutableRelics = first.relics as PersistedRelic[];

      mutableRelics.push({ id: 'leaked' });

      expect(buildEnvelope().relics).toEqual([]);
    });

  it('normalises the cursor it is handed rather than aliasing it', () => {
    const source: Partial<RngCursorMap> = { 'spawn-value': 5 };
    const state = createFreshRunState({
      ...buildInput(),
      rngCursor: source,
    });

    expect(state.rngCursor).not.toBe(source);
    expect(state.rngCursor['spawn-value']).toBe(5);
    expect(state.rngCursor['rarity-weight']).toBe(0);
  });
});

describe('a fresh envelope starts a run at its initial values', () => {
  it('starts at the stage index it is handed', () => {
    expect(buildEnvelope().stageIndex).toBe(INITIAL_STAGE_INDEX);
  });

  it('starts goal progress at zero', () => {
    expect(buildEnvelope().goalProgress).toBe(0);
  });

  it('starts with no relics held', () => {
    const relics = buildEnvelope().relics;

    expect(relics).toEqual([]);
    expect(Array.isArray(relics)).toBe(true);
  });

  it('starts every substream cursor at zero', () => {
    const cursor = buildEnvelope().rngCursor;

    expect(Object.keys(cursor).sort()).toEqual([...CURSOR_STREAMS].sort());

    for (const name of CURSOR_STREAMS) {
      expect(cursor[name]).toBe(0);
    }
  });

  it('carries the goal the stage ladder produces for that index', () => {
    const state = buildEnvelope();
    const ladderGoal: StageGoal = stageGoalForIndex(
      INITIAL_STAGE_INDEX,
      createDefaultStageConfig()
    );

    expect(state.stageGoal).toEqual(ladderGoal);
    expect(state.stageGoal.kind).toBe(ladderGoal.kind);
    expect(state.stageGoal.target).toBe(ladderGoal.target);
  });

  it('is structurally complete and classified as the current version', () => {
    const state = buildEnvelope();

    expect(describeRunStateProblems(state)).toEqual([]);
    expect(isRunStateShape(state)).toBe(true);
    expect(classifyRunStateVersion(state)).toBe('current');
  });
});

/* ===== 13. RunSummary ===== */

describe('a run summary is producible from an envelope', () => {
  it('projects exactly the five summary members', () => {
    const summary: RunSummary = summarizeRunState(buildEnvelope());

    expect(Object.keys(summary).sort()).toEqual([...SUMMARY_MEMBERS]);
  });

  it('carries the seed the run-summary screen displays and copies', () => {
    const input = buildInput();
    const summary = summarizeRunState(createFreshRunState(input));

    expect(summary.seed).toBe(input.seed);
  });

  it('reads the score through the wrapped board', () => {
    const summary = summarizeRunState(buildEnvelope());

    expect(summary.score).toBe(FIXTURE_SCORE);
  });

  it('carries the run identifier and the stage reached', () => {
    const input = buildInput();
    const summary = summarizeRunState(createFreshRunState(input));

    expect(summary.runId).toBe(input.runId);
    expect(summary.stageIndex).toBe(input.stageIndex);
  });

  it('preserves relic pickup order', () => {
    const ids = ['first', 'second', 'third'];
    const summary = summarizeRunState(
      buildEnvelopeWithRelics(ids.map((id) => ({ id })))
    );

    expect(summary.relics.map((relic) => relic.id)).toEqual(ids);
  });

  it('is JSON-serialisable and round-trips deep-equal', () => {
    const summary = summarizeRunState(
      buildEnvelopeWithRelics([{ id: 'held', charges: 2, state: { n: 1 } }])
    );
    const restored = JSON.parse(JSON.stringify(summary)) as RunSummary;

    expect(restored).toEqual(summary);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(summary));
  });

  it('is a fresh object on every call', () => {
    const state = buildEnvelope();
    const first = summarizeRunState(state);
    const second = summarizeRunState(state);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

/* ===== 14. Correlation identity and the injected report sink ===== */

describe('the run layer derives correlation identity from what it persists',
  () => {
    it('exports the derivation its own contract requires', () => {
      const surface = Object.keys(runStateModule);

      expect(surface).toContain('runCorrelationId');
      expect(typeof runCorrelationId).toBe('function');
    });

    it('does not re-export the observability derivation under its own name',
      () => {
        // The two are separate implementations of one algorithm, pinned equal
        // below. A re-export would put an import from src/observability/ in
        // src/run/, which this module's constraints forbid.
        expect(Object.keys(runStateModule)).not.toContain(
          'deriveCorrelationId'
        );
      });

    it('persists both derivation inputs, the seed and the run identifier',
      () => {
        const state = buildEnvelope();

        expect(typeof state.seed).toBe('string');
        expect(typeof state.runId).toBe('string');
        expect(state.runId.length).toBeGreaterThan(0);
        expect(state.seed.length).toBeGreaterThan(0);
      });

    it('carries both inputs through a reload unchanged, so a resumed run ' +
      'reports under the identifier it already reported under', () => {
      const input = buildInput();
      const restored = JSON.parse(
        JSON.stringify(createFreshRunState(input))
      ) as RunState;

      expect(restored.seed).toBe(input.seed);
      expect(restored.runId).toBe(input.runId);
    });

    it('keeps the run identifier separate from the seed, so two runs of one ' +
      'seed are distinguishable', () => {
      const shared = buildInput();
      const first = createFreshRunState({ ...shared, runId: 'run-a' });
      const second = createFreshRunState({
        ...buildInput(),
        seed: shared.seed,
        runId: 'run-b',
      });

      expect(first.seed).toBe(second.seed);
      expect(first.runId).not.toBe(second.runId);
    });

    it('traces every envelope member to an argument or a fixed constant',
      () => {
        const input = buildInput();
        const state = createFreshRunState(input);

        expect(state.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
        expect(state.runId).toBe(input.runId);
        expect(state.seed).toBe(input.seed);
        expect(state.stageIndex).toBe(input.stageIndex);
        expect(state.stageGoal).toBe(input.stageGoal);
        expect(state.board).toBe(input.board);
        expect(state.goalProgress).toBe(0);
        expect(state.relics).toEqual([]);
        expect(state.rngCursor).toEqual(normalizeRngCursor(input.rngCursor));
      });

    it('builds the same envelope from the same argument, repeatedly', () => {
      const input = buildInput();

      expect(JSON.stringify(createFreshRunState(input))).toBe(
        JSON.stringify(createFreshRunState(input))
      );
    });

    it('builds the same envelope after a real delay, reading no clock',
      async () => {
        const input = buildInput();
        const before = createFreshRunState(input);

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2);
        });

        expect(JSON.stringify(createFreshRunState(input))).toBe(
          JSON.stringify(before)
        );
      });

    it('summarises the same envelope after a real delay, reading no clock',
      async () => {
        const state = buildEnvelope();
        const before = summarizeRunState(state);

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2);
        });

        expect(JSON.stringify(summarizeRunState(state))).toBe(
          JSON.stringify(before)
        );
      });
  });

describe('NOOP_RUN_REPORTER satisfies the injected report sink', () => {
  it('is assignable to the reporter port every run module falls back to',
    () => {
      const reporter: RunReporter = NOOP_RUN_REPORTER;

      expect(reporter).toBe(NOOP_RUN_REPORTER);
    });

  it('implements every declared channel as a function', () => {
    const sink = NOOP_RUN_REPORTER as unknown as Record<string, unknown>;

    expect(Object.keys(sink).sort()).toEqual([...REPORTER_CHANNELS].sort());

    for (const channel of REPORTER_CHANNELS) {
      expect(typeof sink[channel]).toBe('function');
    }
  });

  it('discards every report without throwing or returning a value', () => {
    const sink = NOOP_RUN_REPORTER as unknown as Record<
      string,
      (report: unknown) => unknown
    >;

    for (const channel of REPORTER_CHANNELS) {
      const handler = sink[channel];

      expect(() => handler({})).not.toThrow();
      expect(handler({})).toBeUndefined();
    }
  });

  it('is frozen, so an injected channel cannot be replaced in place', () => {
    expect(Object.isFrozen(NOOP_RUN_REPORTER)).toBe(true);
  });
});

/* ===== 15. The persisted relic triple, and teardown hygiene ===== */

describe('the persisted relic triple matches the relics declaration', () => {
  it('is identical in both directions, checked at compile time', () => {
    expect(relicTripleIsIdentical).toBe(true);
    expect(boardSnapshotAliasHolds).toBe(true);
    expect(versionVerdictUnionIsExhaustive).toBe(true);
  });

  it('is assignable both ways between the two declarations', () => {
    expect(runAcceptsRelicsTriple).toBeDefined();
    expect(relicsAcceptsRunTriple).toBeDefined();
  });

  it('declares identity, charges and state and no fourth member', () => {
    const relic: PersistedRelic = {
      id: 'gilded-spawn',
      charges: 1,
      state: null,
    };

    expect(Object.keys(relic).sort()).toEqual(['charges', 'id', 'state']);
  });
});

describe('storage teardown removes the key the product never removed', () => {
  // js/local_storage_manager.js L61-L63 removed the board snapshot alone.
  it('records a best score and every other owned key', () => {
    storage.setItem(BEST_SCORE_KEY, '99999');

    for (const key of OWNED_STORAGE_KEYS) {
      storage.setItem(key, 'written');
    }

    expect(storage.getItem(BEST_SCORE_KEY)).toBe('written');
  });

  it('finds no best score left behind by the preceding test', () => {
    expect(bestScoreAtEntry).toBeUndefined();

    for (const key of OWNED_STORAGE_KEYS) {
      expect(storage.getItem(key)).toBeUndefined();
    }
  });

  it('removes an already-clean store without throwing', () => {
    expect(() => {
      clearOwnedKeys();
      clearOwnedKeys();
    }).not.toThrow();

    expect(storage.getItem(BEST_SCORE_KEY)).toBeUndefined();
  });
});


/* ===== 16. isPersistedRelicState, the wire vocabulary ===== */

describe('isPersistedRelicState accepts the persistable vocabulary', () => {
  it('accepts each primitive the vocabulary names', () => {
    for (const value of ['text', 0, -1, 1.5, true, false, null]) {
      expect(isPersistedRelicState(value)).toBe(true);
    }
  });

  it('accepts a plain object of counters and flags', () => {
    expect(
      isPersistedRelicState({ fired: 3, armed: true, label: 'x' })
    ).toBe(true);
  });

  it('accepts an array, an empty array and an empty object', () => {
    expect(isPersistedRelicState([1, 'two', false, null])).toBe(true);
    expect(isPersistedRelicState([])).toBe(true);
    expect(isPersistedRelicState({})).toBe(true);
  });

  it('accepts nesting the copy descends to', () => {
    expect(
      isPersistedRelicState({ a: { b: { c: [{ d: 1 }] } } })
    ).toBe(true);
  });

  it('accepts a null-prototype object holding data', () => {
    const bare = Object.create(null) as Record<string, unknown>;

    bare.count = 1;

    expect(isPersistedRelicState(bare)).toBe(true);
  });

  it('accepts the same value reached by two different paths', () => {
    const shared = { n: 1 };

    expect(isPersistedRelicState({ left: shared, right: shared })).toBe(true);
  });
});

describe('isPersistedRelicState refuses what persistence cannot carry', () => {
  it('refuses a number that is not finite', () => {
    const nonFinite = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const value of nonFinite) {
      expect(isPersistedRelicState(value)).toBe(false);
    }
  });

  it('refuses undefined, a function, a symbol and a bigint', () => {
    const outside: readonly unknown[] = [
      undefined,
      (): number => 1,
      Symbol('s'),
      BigInt(1),
    ];

    for (const value of outside) {
      expect(isPersistedRelicState(value)).toBe(false);
    }
  });

  it('refuses an object that is not data alone', () => {
    const notData: readonly unknown[] = [
      new Date(0),
      new Map(),
      new Set(),
      new Error('boom'),
      /regex/,
    ];

    for (const value of notData) {
      expect(isPersistedRelicState(value)).toBe(false);
    }
  });

  it('refuses a member holding a value outside the vocabulary', () => {
    expect(isPersistedRelicState({ when: new Date(0) })).toBe(false);
    expect(isPersistedRelicState({ run: (): void => undefined })).toBe(false);
    expect(isPersistedRelicState({ count: Number.NaN })).toBe(false);
  });

  it('refuses each reserved member name', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const hostile: Record<string, unknown> = {};

      Object.defineProperty(hostile, name, {
        value: 1,
        configurable: true,
        enumerable: true,
        writable: true,
      });

      expect(isPersistedRelicState(hostile)).toBe(false);
    }
  });

  it('refuses an accessor rather than running its getter', () => {
    let reads = 0;
    const hostile: Record<string, unknown> = {};

    Object.defineProperty(hostile, 'computed', {
      get(): number {
        reads += 1;

        return 1;
      },
      configurable: true,
      enumerable: true,
    });

    expect(isPersistedRelicState(hostile)).toBe(false);
    expect(reads).toBe(0);
  });

  it('refuses a symbol-keyed member', () => {
    const hostile: Record<string | symbol, unknown> = { count: 1 };

    hostile[Symbol('hidden')] = 2;

    expect(isPersistedRelicState(hostile)).toBe(false);
  });

  it('refuses a cycle without recursing forever', () => {
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    expect(() => isPersistedRelicState(cyclic)).not.toThrow();
    expect(isPersistedRelicState(cyclic)).toBe(false);
  });

  it('refuses a cycle reached through an array', () => {
    const entries: unknown[] = [];

    entries.push(entries);

    expect(() => isPersistedRelicState(entries)).not.toThrow();
    expect(isPersistedRelicState(entries)).toBe(false);
  });

  it('refuses an array hole, which JSON would rewrite as null', () => {
    const holed: unknown[] = [1];

    holed.length = 3;

    expect(isPersistedRelicState(holed)).toBe(false);
  });

  it('refuses a value nested deeper than the copy descends', () => {
    let deep: Record<string, unknown> = { leaf: 1 };

    for (let level = 0; level < 12; level += 1) {
      deep = { down: deep };
    }

    expect(() => isPersistedRelicState(deep)).not.toThrow();
    expect(isPersistedRelicState(deep)).toBe(false);
  });

  it('never throws for any input it is handed', () => {
    for (const value of HOSTILE_INPUTS) {
      expect(() => isPersistedRelicState(value)).not.toThrow();
    }
  });
});

/* ===== 17. A relic's own state, diagnosed field-scoped ===== */

/**
 * Builds a loose payload whose single relic carries `state`.
 *
 * @param state Value to place in the relic's state slot.
 * @returns The payload, ready for the validators.
 */
function payloadWithRelicState(state: unknown): Record<string, unknown> {
  const payload = loosenEnvelope();

  payload.relics = [{ id: 'held', state }];

  return payload;
}

describe('a relic state member is diagnosed by its own path', () => {
  it('reports nothing when the state member is absent', () => {
    const payload = loosenEnvelope();

    payload.relics = [{ id: 'held' }];

    expect(describeRunStateProblems(payload)).toEqual([]);
  });

  it('reports nothing for a state of counters and flags', () => {
    const payload = payloadWithRelicState({ fired: 2, armed: false });

    expect(describeRunStateProblems(payload)).toEqual([]);
  });

  it('names the dotted path of a refused nested member', () => {
    const payload = payloadWithRelicState({ inner: { when: new Date(0) } });

    expect(describeRunStateProblems(payload)).toContain(
      'relics[0].state.inner.when is not a plain object or array'
    );
  });

  it('names the index of a refused array entry', () => {
    const payload = payloadWithRelicState([1, Number.NaN]);

    expect(describeRunStateProblems(payload)).toContain(
      'relics[0].state[1] is not a finite number'
    );
  });

  it('names a reserved member name', () => {
    const hostile: Record<string, unknown> = {};

    Object.defineProperty(hostile, 'constructor', {
      value: 1,
      configurable: true,
      enumerable: true,
      writable: true,
    });

    expect(
      describeRunStateProblems(payloadWithRelicState(hostile))
    ).toContain('relics[0].state.constructor is a reserved member name');
  });

  it('names a cycle once rather than recursing forever', () => {
    const cyclic: Record<string, unknown> = {};

    cyclic.self = cyclic;

    const problems = describeRunStateProblems(
      payloadWithRelicState(cyclic)
    );

    expect(problems).toContain(
      'relics[0].state.self refers back to a value containing it'
    );
    expect(
      problems.filter((problem) => problem.includes('refers back')).length
    ).toBe(1);
  });

  it('names an accessor without running its getter', () => {
    let reads = 0;
    const hostile: Record<string, unknown> = {};

    Object.defineProperty(hostile, 'computed', {
      get(): number {
        reads += 1;

        return 1;
      },
      configurable: true,
      enumerable: true,
    });

    expect(
      describeRunStateProblems(payloadWithRelicState(hostile))
    ).toContain('relics[0].state.computed is an accessor');
    expect(reads).toBe(0);
  });

  it('keeps the pickup index of the offending relic', () => {
    const payload = loosenEnvelope();

    payload.relics = [
      { id: 'first' },
      { id: 'second' },
      { id: 'third', state: { when: new Date(0) } },
    ];

    expect(describeRunStateProblems(payload)).toContain(
      'relics[2].state.when is not a plain object or array'
    );
  });

  it('reports a bounded list for a wide corrupt state', () => {
    const wide: Record<string, unknown> = {};

    for (let index = 0; index < 200; index += 1) {
      wide[`member${index}`] = Number.NaN;
    }

    const problems = describeRunStateProblems(payloadWithRelicState(wide));

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.length).toBeLessThanOrEqual(32);
  });

  it('refuses the envelope whose relic state is not persistable', () => {
    expect(isRunStateShape(payloadWithRelicState({ when: new Date(0) })))
      .toBe(false);
  });

  it('accepts the envelope whose relic state is persistable', () => {
    expect(isRunStateShape(payloadWithRelicState({ fired: 1 }))).toBe(true);
  });
});

/* ===== 18. The run seed is bounded by what the RNG layer derives from ===== */

describe('the persisted run seed is bounded, not merely typed', () => {
  it('accepts a seed at the length the RNG layer can derive from', () => {
    const payload = loosenEnvelope();

    payload.seed = 'a'.repeat(MAX_RUN_SEED_LENGTH);

    expect(describeRunStateProblems(payload)).toEqual([]);
    expect(isRunStateShape(payload)).toBe(true);
  });

  it('names the seed when it is longer than the RNG layer accepts', () => {
    const payload = loosenEnvelope();

    payload.seed = 'a'.repeat(MAX_RUN_SEED_LENGTH + 1);

    expect(isRunStateShape(payload)).toBe(false);
    expect(
      describeRunStateProblems(payload).some((problem) =>
        problem.startsWith('seed is longer than')
      )
    ).toBe(true);
  });

  it('accepts an empty seed as a string the RNG layer can derive from', () => {
    const payload = loosenEnvelope();

    payload.seed = '';

    expect(isRunStateShape(payload)).toBe(true);
  });
});

/* ===== 19. isCurrentRunState ===== */

describe('isCurrentRunState decides shape and version together', () => {
  it('accepts a fresh envelope', () => {
    expect(isCurrentRunState(buildEnvelope())).toBe(true);
  });

  it('refuses a structurally complete envelope at another version', () => {
    for (const offset of [1, -1, 99]) {
      const payload = loosenEnvelope();

      payload.schemaVersion = RUN_STATE_SCHEMA_VERSION + offset;

      expect(isRunStateShape(payload)).toBe(true);
      expect(isCurrentRunState(payload)).toBe(false);
    }
  });

  it('refuses an envelope at the current version but wrong in shape', () => {
    const payload = loosenEnvelope();

    delete payload.board;

    expect(classifyRunStateVersion(payload)).toBe('current');
    expect(isCurrentRunState(payload)).toBe(false);
  });

  it('refuses a payload carrying no version member at all', () => {
    const payload = loosenEnvelope();

    delete payload.schemaVersion;

    expect(isCurrentRunState(payload)).toBe(false);
  });

  it('refuses every non-envelope value without throwing', () => {
    for (const input of HOSTILE_INPUTS) {
      expect(() => isCurrentRunState(input)).not.toThrow();
      expect(isCurrentRunState(input)).toBe(false);
    }
  });
});

/* ===== 20. projectCurrentRunState ===== */

describe('projectCurrentRunState writes the version this build reads', () => {
  it('stamps the current version over any other', () => {
    const stale: RunState = {
      ...buildEnvelope(),
      schemaVersion: RUN_STATE_SCHEMA_VERSION + 5,
    };

    expect(projectCurrentRunState(stale).schemaVersion).toBe(
      RUN_STATE_SCHEMA_VERSION
    );
  });

  it('emits exactly the nine members', () => {
    const projected = projectCurrentRunState(buildEnvelope());

    expect(Object.keys(projected).sort()).toEqual(
      [...ENVELOPE_MEMBERS].sort()
    );
  });

  it('drops a member a caller added to its own object', () => {
    const foreign = {
      ...buildEnvelope(),
      smuggled: 'value',
    } as unknown as RunState;

    expect(Object.keys(projectCurrentRunState(foreign))).not.toContain(
      'smuggled'
    );
  });

  it('produces an envelope this build classifies as current', () => {
    const projected = projectCurrentRunState(buildEnvelope());

    expect(isCurrentRunState(projected)).toBe(true);
  });

  it('shares no mutable part with its argument', () => {
    const state = buildEnvelope();
    const projected = projectCurrentRunState(state);

    expect(projected).not.toBe(state);
    expect(projected.board).not.toBe(state.board);
    expect(projected.board.grid).not.toBe(state.board.grid);
    expect(projected.board.grid.cells).not.toBe(state.board.grid.cells);
    expect(projected.rngCursor).not.toBe(state.rngCursor);
    expect(projected.stageGoal).not.toBe(state.stageGoal);
  });

  it('round-trips through JSON deep-equal to itself', () => {
    const projected = projectCurrentRunState(
      buildEnvelopeWithRelics([{ id: 'held', charges: 1 }])
    );
    const restored = JSON.parse(JSON.stringify(projected)) as RunState;

    expect(restored).toEqual(projected);
  });
});

/* ===== 21. The redacted summary a report carries ===== */

describe('a report summary carries every member except the seed', () => {
  it('removes the seed and keeps the other four members', () => {
    const summary = summarizeRunState(buildEnvelope());
    const redacted = redactRunSummary(summary);

    expect(Object.keys(redacted).sort()).toEqual([
      'relics',
      'runId',
      'score',
      'stageIndex',
    ]);
    expect(Object.keys(redacted)).not.toContain('seed');
  });

  it('keeps the run identifier, the score and the stage reached', () => {
    const summary = summarizeRunState(buildEnvelope());
    const redacted = redactRunSummary(summary);

    expect(redacted.runId).toBe(summary.runId);
    expect(redacted.score).toBe(summary.score);
    expect(redacted.stageIndex).toBe(summary.stageIndex);
  });

  it('preserves relic pickup order', () => {
    const ids = ['first', 'second', 'third'];
    const redacted = redactRunSummary(
      summarizeRunState(buildEnvelopeWithRelics(ids.map((id) => ({ id }))))
    );

    expect(redacted.relics.map((relic) => relic.id)).toEqual(ids);
  });

  it('projects an envelope straight to the redacted form', () => {
    const state = buildEnvelope();
    const direct = summarizeRunStateForReport(state);

    expect(direct).toEqual(redactRunSummary(summarizeRunState(state)));
    expect(Object.keys(direct)).not.toContain('seed');
  });

  it('carries no seed anywhere in its serialised form', () => {
    const input = buildInput();
    const direct = summarizeRunStateForReport(createFreshRunState(input));

    expect(JSON.stringify(direct)).not.toContain(input.seed);
  });

  it('is a fresh object sharing no relic with the summary', () => {
    const summary = summarizeRunState(
      buildEnvelopeWithRelics([{ id: 'held', state: { n: 1 } }])
    );
    const redacted = redactRunSummary(summary);

    expect(redacted.relics).not.toBe(summary.relics);
    expect(redacted.relics[0]).not.toBe(summary.relics[0]);
    expect(redacted.relics[0].state).not.toBe(summary.relics[0].state);
  });
});


/* ===== 22. runCorrelationId, and its equality with the logger's ===== */

// Every pair the two derivations are compared over: ordinary values, the
// boundaries, and the inputs a hand-rolled hash is most likely to disagree on
// — an empty string, a NUL byte inside a member, a member whose text is the
// other member's, and text outside the BMP whose UTF-16 units the two loops
// must walk identically.
type CorrelationInput = readonly [string, string];

const CORRELATION_INPUTS: readonly CorrelationInput[] = Object.freeze(
  [
    ['seed-42', 'run-1'],
    ['run-seed-2048', 'instance-a'],
    ['', ''],
    ['', 'lonely-run'],
    ['lonely-seed', ''],
    ['a', 'b'],
    ['b', 'a'],
    ['same', 'same'],
    ['with\u0000nul', 'plain'],
    ['plain', 'with\u0000nul'],
    ['\u{1F600}\u{1F601}', '\u{1F602}'],
    ['seed with spaces and, punctuation!', 'run/id?with=chars'],
    ['0', '0'],
    ['9007199254740993', '-1'],
    ['x'.repeat(64), 'y'.repeat(64)],
  ]
);

describe('runCorrelationId derives the identifier from what is persisted',
  () => {
    it('is deterministic across repeated calls', () => {
      for (const [seed, runId] of CORRELATION_INPUTS) {
        expect(runCorrelationId(seed, runId)).toBe(
          runCorrelationId(seed, runId)
        );
      }
    });

    it('reads no clock: the same inputs survive a real delay', async () => {
      const before = runCorrelationId('timed-seed', 'timed-run');

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2);
      });

      expect(runCorrelationId('timed-seed', 'timed-run')).toBe(before);
    });

    it('derives the seed-grouping form when the run identifier is omitted',
      () => {
        const grouped = runCorrelationId('grouped-seed');

        expect(grouped).toBe(runCorrelationId('grouped-seed', ''));
        expect(grouped).toHaveLength(18);
        expect(grouped.startsWith('run-')).toBe(true);
      });

    it('derives the 26-character run-instance form when one is supplied',
      () => {
        const instance = runCorrelationId('grouped-seed', 'instance');

        expect(instance).toHaveLength(26);
        expect(instance).toMatch(/^run-[0-9a-z]{14}-[0-9a-z]{7}$/);

        // NO SEED-ONLY SEGMENT. The recoverable seed-grouping form is not
        // inside the form the composition root exports. DL-LOG-09.
        expect(
          instance.startsWith(runCorrelationId('grouped-seed'))
        ).toBe(false);
      });

    it('keys every run of one seed by its own run identifier', () => {
      const grouped = runCorrelationId('shared-seed');
      const first = runCorrelationId('shared-seed', 'run-a');
      const second = runCorrelationId('shared-seed', 'run-b');

      // TWO RUNS OF ONE SEED SHARE NOTHING. A shared prefix was a grouping
      // convenience no module reads and a dictionary matcher every export
      // carried; the run identifier keys both segments instead, and a consumer
      // grouping replays compares `seed` — which the envelope holds and no
      // report carries.
      expect(first.startsWith(grouped)).toBe(false);
      expect(second.startsWith(grouped)).toBe(false);
      expect(first.slice(0, 18)).not.toBe(second.slice(0, 18));
      expect(first).not.toBe(second);
    });

    it('separates two seeds that share a run identifier', () => {
      expect(runCorrelationId('seed-a', 'shared-run')).not.toBe(
        runCorrelationId('seed-b', 'shared-run')
      );
    });

    it('is not the bare hash of the run identifier alone', () => {
      // The instance segment is hashed over the run identifier AND the seed,
      // so it cannot be read back as a hash of `runId`.
      const withSeed = runCorrelationId('a-seed', 'the-run');
      const withoutSeed = runCorrelationId('', 'the-run');

      expect(withSeed.slice(-7)).not.toBe(withoutSeed.slice(-7));
    });

    it('carries the seed text in neither form', () => {
      const seed = 'a-very-distinctive-seed-text';

      expect(runCorrelationId(seed)).not.toContain(seed);
      expect(runCorrelationId(seed, 'run')).not.toContain(seed);
    });

    it('is non-empty and base36 after the prefix for every input', () => {
      for (const [seed, runId] of CORRELATION_INPUTS) {
        for (const derived of [
          runCorrelationId(seed),
          runCorrelationId(seed, runId),
        ]) {
          expect(derived.length).toBeGreaterThan(0);
          expect(derived).toMatch(/^run-[0-9a-z]{14}(-[0-9a-z]{7})?$/);
        }
      }
    });

    it('never throws, coercing every argument it is handed', () => {
      const hostile = [
        undefined,
        null,
        0,
        Number.NaN,
        true,
        [],
        {},
      ] as unknown[];

      for (const value of hostile) {
        expect(() =>
          runCorrelationId(value as string, value as string)
        ).not.toThrow();
        expect(
          typeof runCorrelationId(value as string, value as string)
        ).toBe('string');
      }
    });

    it('re-derives from a reloaded envelope alone', () => {
      const input = buildInput();
      const restored = JSON.parse(
        JSON.stringify(createFreshRunState(input))
      ) as RunState;

      expect(runCorrelationId(restored.seed, restored.runId)).toBe(
        runCorrelationId(input.seed, input.runId)
      );
    });
  });

describe('runCorrelationId is byte-equal to the logger derivation', () => {
  it('agrees on the run-instance form for every input pair', () => {
    for (const [seed, runId] of CORRELATION_INPUTS) {
      expect(runCorrelationId(seed, runId)).toBe(
        deriveCorrelationId(seed, runId)
      );
    }
  });

  it('agrees on the seed-grouping form for every seed', () => {
    for (const [seed] of CORRELATION_INPUTS) {
      expect(runCorrelationId(seed)).toBe(deriveCorrelationId(seed));
      expect(runCorrelationId(seed, '')).toBe(deriveCorrelationId(seed, ''));
    }
  });

  it('agrees character for character, not merely in length', () => {
    for (const [seed, runId] of CORRELATION_INPUTS) {
      const mine = runCorrelationId(seed, runId);
      const theirs = deriveCorrelationId(seed, runId);

      expect(mine.split('')).toEqual(theirs.split(''));
    }
  });

  it('agrees for hostile arguments both coerce', () => {
    const hostile = [undefined, null, 0, Number.NaN, true] as unknown[];

    for (const value of hostile) {
      expect(runCorrelationId(value as string, value as string)).toBe(
        deriveCorrelationId(value as string, value as string)
      );
    }
  });

  it('agrees over a generated sweep of seeds and run identifiers', () => {
    for (let index = 0; index < 64; index += 1) {
      const seed = `sweep-seed-${index}`;
      const runId = `sweep-run-${index * 7 + 1}`;

      expect(runCorrelationId(seed, runId)).toBe(
        deriveCorrelationId(seed, runId)
      );
    }
  });
});

/* ===== 23. The injectable version policy ===== */

// A policy naming a genuine prior version. `RUN_STATE_SCHEMA_VERSION_HISTORY`
// holds one entry in this build, so without an injected policy the 'older'
// verdict is unreachable and every assertion over it is vacuous.
const PRIOR_VERSION = RUN_STATE_SCHEMA_VERSION;

const NEXT_VERSION = RUN_STATE_SCHEMA_VERSION + 1;

const TWO_VERSION_POLICY: RunStateVersionPolicy = Object.freeze({
  current: NEXT_VERSION,
  history: Object.freeze([PRIOR_VERSION, NEXT_VERSION]),
});

describe('the shipped version policy mirrors the module constants', () => {
  it('names the current version and the whole history', () => {
    expect(RUN_STATE_VERSION_POLICY.current).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(RUN_STATE_VERSION_POLICY.history).toEqual(
      RUN_STATE_SCHEMA_VERSION_HISTORY
    );
  });

  it('is what an omitted policy resolves to', () => {
    expect(resolveRunStateVersionPolicy()).toBe(RUN_STATE_VERSION_POLICY);
    expect(resolveRunStateVersionPolicy(undefined)).toBe(
      RUN_STATE_VERSION_POLICY
    );
  });

  it('leaves classification unchanged when it is the one supplied', () => {
    const stored = { schemaVersion: RUN_STATE_SCHEMA_VERSION };

    expect(classifyRunStateVersion(stored, RUN_STATE_VERSION_POLICY)).toBe(
      classifyRunStateVersion(stored)
    );
  });
});

describe('resolveRunStateVersionPolicy is total over a hostile policy', () => {
  it('replaces a non-integer current version with the shipped one', () => {
    for (const current of [
      'two',
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      null,
    ] as unknown[]) {
      const resolved = resolveRunStateVersionPolicy({
        current,
        history: [1],
      } as unknown as RunStateVersionPolicy);

      expect(resolved.current).toBe(RUN_STATE_SCHEMA_VERSION);
    }
  });

  it('drops every non-integer history entry', () => {
    const resolved = resolveRunStateVersionPolicy({
      current: NEXT_VERSION,
      history: [1, 'two', 2.5, Number.NaN, NEXT_VERSION],
    } as unknown as RunStateVersionPolicy);

    expect(resolved.history).toEqual([1, NEXT_VERSION]);
  });

  it('adds the current version to a history that omits it', () => {
    const resolved = resolveRunStateVersionPolicy({
      current: NEXT_VERSION,
      history: [PRIOR_VERSION],
    });

    expect(resolved.history).toContain(NEXT_VERSION);
    expect(resolved.history).toContain(PRIOR_VERSION);
  });

  it('returns an ascending, frozen history', () => {
    const resolved = resolveRunStateVersionPolicy({
      current: 9,
      history: [9, 3, 7, 1],
    });

    expect(resolved.history).toEqual([1, 3, 7, 9]);
    expect(Object.isFrozen(resolved.history)).toBe(true);
    expect(Object.isFrozen(resolved)).toBe(true);
  });

  it('does not mutate the history it was handed', () => {
    const history = [3, 1, 2];
    const policy: RunStateVersionPolicy = { current: 2, history };

    resolveRunStateVersionPolicy(policy);

    expect(history).toEqual([3, 1, 2]);
  });

  it('degrades to the shipped policy when a member accessor throws', () => {
    const hostile = {
      get current(): number {
        throw new Error('current refused');
      },
      get history(): readonly number[] {
        throw new Error('history refused');
      },
    } as RunStateVersionPolicy;

    expect(() => resolveRunStateVersionPolicy(hostile)).not.toThrow();
    expect(resolveRunStateVersionPolicy(hostile)).toBe(
      RUN_STATE_VERSION_POLICY
    );
  });

  it('degrades for a policy that is not an object at all', () => {
    for (const value of [null, 0, 'policy', true] as unknown[]) {
      expect(() =>
        resolveRunStateVersionPolicy(value as RunStateVersionPolicy)
      ).not.toThrow();
    }
  });
});

describe('classifyRunStateVersion reaches older through a policy', () => {
  it('exercises a NON-EMPTY set of versions below the current one', () => {
    const resolved = resolveRunStateVersionPolicy(TWO_VERSION_POLICY);
    const older = resolved.history.filter(
      (version) => version < resolved.current
    );

    // The assertion the shipped constants cannot satisfy: without it, every
    // loop below would pass over an empty set and prove nothing.
    expect(older.length).toBeGreaterThan(0);

    for (const version of older) {
      expect(
        classifyRunStateVersion({ schemaVersion: version }, TWO_VERSION_POLICY)
      ).toBe('older');
    }
  });

  it("reports 'current' for the policy's own current version", () => {
    expect(
      classifyRunStateVersion(
        { schemaVersion: NEXT_VERSION },
        TWO_VERSION_POLICY
      )
    ).toBe('current');
  });

  it("reports 'unknown' above the policy's current version", () => {
    expect(
      classifyRunStateVersion(
        { schemaVersion: NEXT_VERSION + 1 },
        TWO_VERSION_POLICY
      )
    ).toBe('unknown');
  });

  it("reports 'unknown' for a lower version the history omits", () => {
    expect(
      classifyRunStateVersion(
        { schemaVersion: PRIOR_VERSION - 1 },
        TWO_VERSION_POLICY
      )
    ).toBe('unknown');
  });

  it('reclassifies one stored payload under two policies', () => {
    const stored = { schemaVersion: RUN_STATE_SCHEMA_VERSION };

    expect(classifyRunStateVersion(stored)).toBe('current');
    expect(classifyRunStateVersion(stored, TWO_VERSION_POLICY)).toBe('older');
  });

  it('still reports absent, malformed and non-object verdicts', () => {
    expect(classifyRunStateVersion({}, TWO_VERSION_POLICY)).toBe('absent');
    expect(classifyRunStateVersion(null, TWO_VERSION_POLICY)).toBe('absent');
    expect(
      classifyRunStateVersion({ schemaVersion: 1.5 }, TWO_VERSION_POLICY)
    ).toBe('malformed');
    expect(classifyRunStateVersion([], TWO_VERSION_POLICY)).toBe('malformed');
  });

  it('never throws for a hostile policy, whatever the payload', () => {
    const hostile = {
      get current(): number {
        throw new Error('refused');
      },
      get history(): readonly number[] {
        return [];
      },
    } as RunStateVersionPolicy;

    for (const stored of [
      { schemaVersion: RUN_STATE_SCHEMA_VERSION },
      { schemaVersion: 99 },
      {},
      null,
      [],
      'stored',
    ] as unknown[]) {
      expect(() => classifyRunStateVersion(stored, hostile)).not.toThrow();
    }

    expect(
      classifyRunStateVersion({ schemaVersion: RUN_STATE_SCHEMA_VERSION },
        hostile)
    ).toBe('current');
  });

  it('leaves what this build WRITES at the module constant', () => {
    // A policy changes what a reader accepts, never what a writer stamps.
    const state = createFreshRunState(buildInput());

    expect(state.schemaVersion).toBe(RUN_STATE_SCHEMA_VERSION);
    expect(projectCurrentRunState(state).schemaVersion).toBe(
      RUN_STATE_SCHEMA_VERSION
    );
    expect(isCurrentRunState(state)).toBe(true);
  });

  it('stamps a supplied target version when one is given', () => {
    const state = createFreshRunState(buildInput());

    expect(projectCurrentRunState(state, NEXT_VERSION).schemaVersion).toBe(
      NEXT_VERSION
    );
  });

  it('ignores a non-integer target version', () => {
    const state = createFreshRunState(buildInput());

    for (const target of [1.5, Number.NaN, 'two'] as unknown[]) {
      expect(
        projectCurrentRunState(state, target as number).schemaVersion
      ).toBe(RUN_STATE_SCHEMA_VERSION);
    }
  });
});
