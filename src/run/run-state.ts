/**
 * The versioned run-state envelope: the persisted shape of one run.
 *
 * Type declarations, constants and pure functions only. Nothing here reads the
 * DOM, touches Web Storage, performs I/O, reads a clock or consumes
 * randomness: src/run/run-state-store.ts owns persistence, and the seed and
 * the run identifier arrive as arguments rather than being originated here.
 *
 * RUN IDENTIFIER VERSUS CORRELATION IDENTIFIER
 *   `RunState.runId` identifies the run instance and is persisted with the
 *   envelope. The correlation identifier is derived from the seed AND that run
 *   identifier, is not persisted, and is what the observability layer keys
 *   records on. Both inputs are load-bearing: the seed supplies the prefix a
 *   stream is grouped by, and the run identifier is what separates two runs of
 *   one seed within it. Because the run identifier is persisted, a resumed run
 *   re-derives the identifier it was already reporting under.
 *
 *   `runCorrelationId()` below is this module's derivation of it, and is what
 *   the run layer calls when no identifier was injected. It is byte-identical
 *   to `deriveCorrelationId(seed, runId)` in src/observability/logger.ts, which
 *   remains the single authority src/main.ts calls: this module reaches no
 *   observability module, so the two derivations are separate implementations
 *   of one algorithm, pinned equal by
 *   tests/unit/run/run-state.test.ts rather than by a shared import. Every
 *   store, controller and reporter in this folder still takes the identifier by
 *   injection; nothing here calls this function on its own behalf.
 *
 * WRAPPED BOARD SNAPSHOT
 *   `RunState.board` carries the pre-migration board snapshot unchanged, in
 *   the three stages that wrote it: a tile is `{ position: { x, y }, value }`,
 *   a grid is `{ size, cells }` indexed `cells[x][y]` with every empty cell
 *   retained as `null` rather than compacted away, and the board is
 *   `{ grid, score, over, won, keepPlaying }`. The shape is declared once, in
 *   src/engine/types.ts, and is aliased below rather than restated.
 *
 * VERSION MEMBER
 *   The pre-migration payload carried no version, schema or checksum member,
 *   and the pre-migration loader parsed the stored value with no guard.
 *   `schemaVersion` and `classifyRunStateVersion()` are what a loader decides
 *   against instead.
 *
 * BOUNDED QUANTITIES
 *   Three quantities a stored payload carries are bounded rather than
 *   merely typed, and each bound is read from the module that owns it
 *   rather than restated here: the board edge against `MAX_BOARD_SIZE` of
 *   src/config/default-config.ts, every substream draw count against
 *   `isAcceptableRngCursor()` of src/rng/seeded-rng.ts, and a relic's
 *   `state` against the shape limits in section 8. A payload breaking one
 *   of them is refused, not clamped.
 *
 * JSON ROUND-TRIP
 *   Every member of `RunState` is JSON data: strings, finite numbers,
 *   booleans, plain objects and arrays of those. No `Date`, `Map`, `Set`,
 *   class instance or method appears anywhere in the envelope, so
 *   `JSON.parse(JSON.stringify(state))` is deep-equal to `state`. A relic's
 *   own `state` is the one member whose type is `unknown` on the wire;
 *   `PersistedRelicState` states the vocabulary it is drawn from,
 *   `checkRelicState()` decides membership as part of `isRunStateShape()`,
 *   and `cloneRelicState()` carries nothing outside it, so the round-trip
 *   holds for that member too.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-RUN-01  js/game_manager.js L102-L110  the manager projection, wrapped
 *                                            unchanged as `RunState.board`
 *   TR-RUN-02  js/grid.js L102-L117          the grid projection, aliased as
 *                                            `SerializedGrid`
 *   TR-RUN-03  js/tile.js L19-L27            the tile projection, aliased as
 *                                            `SerializedTile`
 *   TR-RUN-04  target-only row               `schemaVersion`,
 *                                            `RUN_STATE_SCHEMA_VERSION`,
 *                                            its history and
 *                                            `classifyRunStateVersion()`
 *   TR-RUN-05  target-only row               `rngCursor` and
 *                                            `normalizeRngCursor()`
 *   TR-RUN-06  target-only row               `relics`, `PersistedRelic` and
 *                                            `PersistedRelicState`
 *   TR-RUN-07  target-only row               the stage slice: `stageIndex`,
 *                                            `stageGoal`, `goalProgress`
 *   TR-RUN-08  target-only row               `isRunStateShape()`,
 *                                            `isCurrentRunState()` and
 *                                            `describeRunStateProblems()`
 *   TR-RUN-09  target-only row               `summarizeRunState()`,
 *                                            `redactRunSummary()` and
 *                                            `summarizeRunStateForReport()`
 *   TR-RUN-10  target-only row               `RunReporter` and
 *                                            `NOOP_RUN_REPORTER`
 *   TR-RUN-11  target-only row               `cloneBoardSnapshot()`, the one
 *                                            board copier every projection of
 *                                            a stored board passes through
 *   TR-RUN-12  target-only row               `pendingReward`,
 *                                            `PendingRewardRound`,
 *                                            `clonePendingReward()` and
 *                                            `checkPendingReward()`, the
 *                                            unresolved reward round
 *
 * Decisions behind this file, argued in docs/DECISION_LOG.md and named here
 * only so the construct can be found from the log:
 *   DL-RUN-01  the `schemaVersion` member and the classification it is read
 *              through
 *   DL-RUN-02  wrapping the pre-migration board snapshot verbatim
 *   DL-RUN-03  persisting the RNG cursor map
 *   DL-RUN-04  a payload breaking a bound refused, never clamped
 *   DL-RUN-05  the seed omitted from the reported summary by
 *              `redactRunSummary()`
 *   DL-RUN-06  the unresolved reward round persisted as an OPTIONAL member
 *              carrying identifiers alone, with `schemaVersion` left where it
 *              stood
 */

import {
  MAX_BOARD_SIZE,
  isSupportedBoardSize,
} from '../config/default-config';
import type { StageGoal, StageGoalKind } from '../config/stage-config';
import type {
  CorrelationId,
  SerializedGameState,
  SerializedGrid,
  SerializedTile,
} from '../engine/types';
import {
  MAX_RUN_SEED_LENGTH,
  RNG_STREAM_NAMES,
  isAcceptableRunSeed,
  type RngCursorMap,
  type StreamName,
} from '../rng/rng-streams';
import {
  MAX_RESUMABLE_CURSOR,
  isAcceptableRngCursor,
} from '../rng/seeded-rng';

/**
 * The board snapshot the envelope wraps, in the shape the pre-migration game
 * wrote under the `gameState` key.
 *
 * Declared as `SerializedGameState` in src/engine/types.ts and aliased here,
 * so this folder names the snapshot vocabulary once and the value the engine's
 * `serialize` returns is assignable to `RunState.board` with no cast.
 */
export type LegacyBoardSnapshot = SerializedGameState;

/**
 * The grid and tile stages of the wrapped snapshot, re-exported so this folder
 * has one import surface for the snapshot vocabulary: a grid is `{ size, cells
 * }` with `cells` indexed `cells[x][y]` and holding `null` in every empty
 * cell, and a tile is `{ position: { x, y }, value }`.
 */
export type { SerializedGrid, SerializedTile };

/**
 * The data vocabulary a relic's own persisted state is drawn from: a string, a
 * finite number, a boolean, `null`, an array of these, or a plain object whose
 * every value is one of these.
 */
export type PersistedRelicState =
  | string
  | number
  | boolean
  | null
  | readonly PersistedRelicState[]
  | { readonly [member: string]: PersistedRelicState };

/**
 * One held relic as the envelope persists it: identity, charges remaining and
 * the relic's own opaque state. Narrower than the in-memory declaration — the
 * wire carries no name, description, rarity or hook table.
 */
export interface PersistedRelic {
  readonly id: string;

  /**
   * Charges remaining. Absent on a relic that carries no charge budget, and
   * `0` on one whose budget is exhausted.
   */
  readonly charges?: number;

  /**
   * The relic's own persisted state, opaque to this module and to the store.
   */
  readonly state?: unknown;
}

/**
 * A reward round drawn and not yet resolved, as it is persisted.
 *
 * The offer alone is not enough. A cleared stage's goal is still met on every
 * later commit, so a resumed run has to know that the stage END was already
 * resolved — the `stage:end` dispatch made, its `onStageEnd` handlers fired and
 * its bounties paid — or it resolves the same stage again. A standing round IS
 * that marker: while one is recorded the stage that drew it is resolved and the
 * run is waiting on a choice.
 *
 * Plain JSON data, carrying identifiers alone. The full offer a screen presents
 * is projected from the relic catalogue by identifier on load, so no name,
 * description or hook list is duplicated into storage where the catalogue could
 * move out from under it.
 */
export interface PendingRewardRound {
  /** Stage whose end drew this offer. */
  readonly stageIndex: number;

  /** Identifiers offered, in the order they were presented. */
  readonly offeredRelicIds: readonly string[];
}

/**
 * One run as it is persisted: nine required members, one optional, and no
 * others.
 *
 * Run state is separate from board state. The board snapshot composes into
 * `board` and is never flattened up to this level, so `score`, `over` and
 * `won` are read through `board`.
 */
export interface RunState {
  /**
   * Schema version of this envelope. Every envelope this build writes carries
   * `RUN_STATE_SCHEMA_VERSION`, and `classifyRunStateVersion` reduces a stored
   * value to the verdict a loader decides against.
   */
  readonly schemaVersion: number;

  /** Opaque identifier of this run instance. */
  readonly runId: string;

  /**
   * The run seed, verbatim, as `SeededRng.seed` and `createRngStreams` in
   * src/rng/ take it.
   */
  readonly seed: string;

  /**
   * Draw count of every named RNG substream as of this envelope.
   * `RngCursorMap` in src/rng/rng-streams.ts is this member's declared shape,
   * and `createRngStreams(seed, rngCursor)` resumes each substream from it.
   */
  readonly rngCursor: RngCursorMap;
  readonly stageIndex: number;

  /**
   * The stage's clear condition, carried verbatim from
   * src/config/stage-config.ts, as plain JSON data.
   */
  readonly stageGoal: StageGoal;

  /**
   * Fraction of `stageGoal.target` reached: the `progress` member
   * `evaluateStageGoal` returns, already clamped by it to the closed interval
   * [0, 1] and finite. Stored as produced; this module neither re-derives nor
   * re-clamps it.
   */
  readonly goalProgress: number;

  /**
   * The relics held, in pickup order. Array order is the pickup order the hook
   * bus dispatches in, so it is preserved on every read and every write and is
   * never sorted, filtered or re-keyed.
   */
  readonly relics: readonly PersistedRelic[];
  readonly board: LegacyBoardSnapshot;

  /**
   * The reward round drawn and not yet resolved, and ABSENT while none stands.
   *
   * Absence is the meaningful state — no choice is owed — and it is the state
   * every envelope written before this member existed is in, which is why the
   * member is optional and `schemaVersion` did not move for it. Decision
   * `DL-RUN-06`.
   */
  readonly pendingReward?: PendingRewardRound;
}

export const RUN_STATE_SCHEMA_VERSION = 1;

/**
 * Every schema version this build can read, ascending, including
 * `RUN_STATE_SCHEMA_VERSION` itself.
 */
export const RUN_STATE_SCHEMA_VERSION_HISTORY: readonly number[] =
  Object.freeze([RUN_STATE_SCHEMA_VERSION]);

/** What a stored payload's `schemaVersion` member amounts to. */
export type RunStateVersionVerdict =
  | 'current'
  | 'older'
  | 'unknown'
  | 'absent'
  | 'malformed';

/**
 * The version set a classification is decided against: which version is
 * current, and which versions this build reads.
 *
 * `RUN_STATE_VERSION_POLICY` is the shipped one. A supplied policy changes
 * nothing about what this build WRITES: `createFreshRunState` and
 * `isCurrentRunState` read `RUN_STATE_SCHEMA_VERSION` directly, so the written
 * version is the module constant whatever a reader was told.
 */
export interface RunStateVersionPolicy {
  /** Version treated as current, and the version a migration re-stamps to. */
  readonly current: number;

  /**
   * Every version this build reads, `current` included. A stored integer this
   * list does not contain is `'unknown'`.
   */
  readonly history: readonly number[];
}

/**
 * The shipped version policy: this build's own current version and history.
 */
export const RUN_STATE_VERSION_POLICY: RunStateVersionPolicy = Object.freeze({
  current: RUN_STATE_SCHEMA_VERSION,
  history: RUN_STATE_SCHEMA_VERSION_HISTORY,
});

/**
 * Reduces a supplied policy to a usable one, falling back to
 * `RUN_STATE_VERSION_POLICY` member by member.
 *
 * `current` is taken only when it is an integer. `history` is taken only when
 * it is an array, and is then reduced to its integer entries with `current`
 * included, so a history that omits its own current version still classifies
 * that version `'current'`.
 *
 * @param policy Policy to resolve, or `undefined` for the shipped one.
 * @returns A policy whose `current` is an integer and whose `history` is a
 *   frozen array of integers containing `current`.
 */
export function resolveRunStateVersionPolicy(
  policy?: RunStateVersionPolicy
): RunStateVersionPolicy {
  if (policy === undefined || policy === null) {
    return RUN_STATE_VERSION_POLICY;
  }

  let current: unknown;
  let history: unknown;

  try {
    current = policy.current;
    history = policy.history;
  } catch {
    return RUN_STATE_VERSION_POLICY;
  }

  const resolvedCurrent = isSchemaVersion(current)
    ? current
    : RUN_STATE_SCHEMA_VERSION;
  const declared = Array.isArray(history)
    ? (history as readonly unknown[]).filter(isSchemaVersion)
    : [];
  const resolvedHistory = declared.includes(resolvedCurrent)
    ? declared
    : [...declared, resolvedCurrent];

  return Object.freeze({
    current: resolvedCurrent,
    history: Object.freeze(
      [...resolvedHistory].sort((left, right) => left - right)
    ),
  });
}

type MemberRead =
  | { readonly readable: true; readonly value: unknown }
  | { readonly readable: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads one member of a plain object without throwing. */
function readMember(
  source: Record<string, unknown>,
  name: string
): MemberRead {
  try {
    return { readable: true, value: source[name] };
  } catch {
    return { readable: false };
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reports whether `value` is a non-negative safe integer: it rejects `NaN`,
 * both infinities, every fractional and negative value, every magnitude beyond
 * the exactly representable integer range, and every value that is not a
 * number.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

function isUnitFraction(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/**
 * Highest board edge length this build reads or writes, re-exported from
 * src/config/default-config.ts rather than restated so this module and
 * src/run/run-state-store.ts cannot disagree about the sizes they accept.
 * Every allocation and every matrix walk across the persistence boundary is
 * bounded by it.
 */
export const MAX_SUPPORTED_BOARD_SIZE = MAX_BOARD_SIZE;

/**
 * Highest number of held relics an envelope carries. Bounds the relic walk
 * independently of the array length a payload declares.
 */
export const MAX_PERSISTED_RELICS = 64;

/**
 * The most identifiers one persisted reward round may carry.
 *
 * A reward screen presents three (AAP R8), and this is the bound a stored round
 * is refused above rather than the count one must hold: a build configured to
 * offer more is not refused by a value this module fixed, and a payload claiming
 * a thousand offers is. Set to `MAX_PERSISTED_RELICS`, since an offer can never
 * usefully be longer than the catalogue a run could hold.
 */
export const MAX_REWARD_OFFER_IDS = MAX_PERSISTED_RELICS;

function isBoardSize(value: unknown): value is number {
  return isSupportedBoardSize(value);
}

function isSchemaVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * Reduces any stored value to the verdict a loader decides against. Total and
 * non-throwing for every input — `null`, `undefined`, arrays, primitives and
 * objects whose accessors throw included — so the guarded loader's no-throw
 * guarantee rests on this function.
 *
 * @param value Stored value to classify.
 * @param policy Version set to decide against, resolved through
 *   `resolveRunStateVersionPolicy`. Defaults to `RUN_STATE_VERSION_POLICY`.
 */
export function classifyRunStateVersion(
  value: unknown,
  policy?: RunStateVersionPolicy
): RunStateVersionVerdict {
  if (value === undefined || value === null) {
    return 'absent';
  }

  if (!isRecord(value)) {
    return 'malformed';
  }

  const member = readMember(value, 'schemaVersion');

  if (!member.readable) {
    return 'malformed';
  }

  if (member.value === undefined) {
    return 'absent';
  }

  if (!isSchemaVersion(member.value)) {
    return 'malformed';
  }

  const version = member.value;
  const resolved = resolveRunStateVersionPolicy(policy);

  if (version === resolved.current) {
    return 'current';
  }

  if (version < resolved.current && resolved.history.includes(version)) {
    return 'older';
  }

  return 'unknown';
}

/**
 * Reduces any value to a total cursor map. Walks `RNG_STREAM_NAMES` and takes
 * one entry per name, so the result carries exactly the substream names that
 * tuple declares, in its order: a name the input omits, or carries an unusable
 * value for, is filled with 0.
 */
export function normalizeRngCursor(value: unknown): RngCursorMap {
  const source = isRecord(value) ? value : null;
  const cursor: Partial<Record<StreamName, number>> = {};

  for (const name of RNG_STREAM_NAMES) {
    const member = source === null ? null : readMember(source, name);
    const recorded =
      member !== null && member.readable ? member.value : undefined;

    // `typeof` narrows the read to a number; `isAcceptableRngCursor` decides
    // whether it is a resumable one, and `> 0` collapses `-0`.
    cursor[name] =
      typeof recorded === 'number' &&
      recorded > 0 &&
      isAcceptableRngCursor(recorded)
        ? recorded
        : 0;
  }

  return cursor as RngCursorMap;
}

export interface FreshRunStateInput {
  readonly runId: string;
  readonly seed: string;

  /** Draw counts to record. */
  readonly rngCursor: Partial<RngCursorMap>;
  readonly stageIndex: number;
  readonly stageGoal: StageGoal;
  readonly board: LegacyBoardSnapshot;
}

/**
 * Assembles a fresh envelope. Pure: no I/O, no clock, no randomness, and
 * neither the seed nor the run identifier is originated here — both arrive as
 * arguments.
 */
export function createFreshRunState(input: FreshRunStateInput): RunState {
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: input.runId,
    seed: input.seed,
    rngCursor: normalizeRngCursor(input.rngCursor),
    stageIndex: input.stageIndex,
    stageGoal: input.stageGoal,
    goalProgress: 0,
    relics: [],
    board: input.board,
  };
}

/**
 * Most problems one diagnosis reports. A list that reaches this length ends
 * with `PROBLEM_LIST_TRUNCATED`, and the matrix and relic walks stop there, so
 * a payload carrying a large corrupt array is diagnosed in bounded work and
 * bounded output.
 */
const MAX_REPORTED_PROBLEMS = 32;

const PROBLEM_LIST_TRUNCATED = 'further problems were not reported';

/** Levels of nesting accepted below a relic's `state` member. */
const MAX_RELIC_STATE_DEPTH = 8;

/** Member names a persisted relic state may not carry. */
const RESERVED_STATE_KEYS: ReadonlySet<string> = new Set<string>([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Most members one object, or elements one array, inside a relic's `state` may
 * carry.
 */
const MAX_RELIC_STATE_BREADTH = 64;

/** Longest string one relic's `state` may carry, in characters. */
const MAX_RELIC_STATE_STRING_LENGTH = 256;

/**
 * Reports whether `value` is an object carrying data alone: a plain object or
 * array whose prototype is `Object.prototype`, `Array.prototype` or `null`.
 *
 * @param value Object to test.
 * @returns `true` for a data-only object.
 */
function isDataObject(value: object): boolean {
  let prototype: unknown;

  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    // A `Proxy` whose trap refuses the read is not data.
    return false;
  }

  if (Array.isArray(value)) {
    return prototype === Array.prototype || prototype === null;
  }

  return prototype === Object.prototype || prototype === null;
}

/**
 * Records a problem for every part of a relic's `state` member that falls
 * outside `PersistedRelicState`.
 *
 * @param value Candidate state, or one of its members.
 * @param path Dotted path the member is reported under.
 * @param problems List to append to.
 * @param depth Levels descended below the `state` member itself.
 * @param ancestors Objects on the path from `state` to `value`.
 */
function checkRelicState(
  value: unknown,
  path: string,
  problems: string[],
  depth: number,
  ancestors: Set<object>
): void {
  if (problems.length >= MAX_REPORTED_PROBLEMS) {
    return;
  }

  if (value === null) {
    return;
  }

  if (value === undefined) {
    addProblem(problems, `${path} is undefined`);

    return;
  }

  const type = typeof value;

  if (type === 'boolean') {
    return;
  }

  if (type === 'string') {
    if ((value as string).length > MAX_RELIC_STATE_STRING_LENGTH) {
      addProblem(
        problems,
        `${path} is longer than ${MAX_RELIC_STATE_STRING_LENGTH} characters`
      );
    }

    return;
  }

  if (type === 'number') {
    if (!isFiniteNumber(value)) {
      addProblem(problems, `${path} is not a finite number`);
    }

    return;
  }

  if (type !== 'object') {
    addProblem(problems, `${path} is a ${type} and is not persistable`);

    return;
  }

  const object = value as object;

  if (ancestors.has(object)) {
    addProblem(problems, `${path} refers back to a value containing it`);

    return;
  }

  if (!isDataObject(object)) {
    addProblem(problems, `${path} is not a plain object or array`);

    return;
  }

  if (depth >= MAX_RELIC_STATE_DEPTH) {
    addProblem(
      problems,
      `${path} is nested deeper than ${MAX_RELIC_STATE_DEPTH} levels`
    );

    return;
  }

  ancestors.add(object);

  try {
    if (Array.isArray(object)) {
      checkRelicStateEntries(object, path, problems, depth, ancestors);

      return;
    }

    checkRelicStateMembers(object, path, problems, depth, ancestors);
  } catch {
    // A read this walk does not already guard — a `Proxy` trap, say — is
    // contained and reported as an unreadable member, as `readMember` contains
    // one at the envelope's own level.
    addProblem(problems, `${path} is not readable`);
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Records a problem for every entry of one persisted state array.
 *
 * @param entries Array to walk.
 * @param path Dotted path the array is reported under.
 * @param problems List to append to.
 * @param depth Levels descended below the `state` member itself.
 * @param ancestors Objects on the path from `state` to `entries`.
 */
function checkRelicStateEntries(
  entries: readonly unknown[],
  path: string,
  problems: string[],
  depth: number,
  ancestors: Set<object>
): void {
  const walked = Math.min(entries.length, MAX_RELIC_STATE_BREADTH);

  if (entries.length > walked) {
    addProblem(
      problems,
      `${path} carries more than ${MAX_RELIC_STATE_BREADTH} entries`
    );
  }

  for (let index = 0; index < walked; index += 1) {
    if (problems.length >= MAX_REPORTED_PROBLEMS) {
      return;
    }

    // `JSON.stringify` writes a hole and an `undefined` entry as `null`; both
    // are reported instead, so an accepted array copies entry for entry.
    if (!Object.prototype.hasOwnProperty.call(entries, index)) {
      addProblem(problems, `${path}[${index}] is absent`);

      continue;
    }

    checkRelicState(
      entries[index],
      `${path}[${index}]`,
      problems,
      depth + 1,
      ancestors
    );
  }
}

/**
 * Records a problem for every member of one persisted state object.
 *
 * @param source Object to walk.
 * @param path Dotted path the object is reported under.
 * @param problems List to append to.
 * @param depth Levels descended below the `state` member itself.
 * @param ancestors Objects on the path from `state` to `source`.
 */
function checkRelicStateMembers(
  source: object,
  path: string,
  problems: string[],
  depth: number,
  ancestors: Set<object>
): void {
  let names: string[];

  try {
    if (Object.getOwnPropertySymbols(source).length > 0) {
      addProblem(problems, `${path} carries a symbol-keyed member`);

      return;
    }

    names = Object.getOwnPropertyNames(source);
  } catch {
    addProblem(problems, `${path} is not readable`);

    return;
  }

  if (names.length > MAX_RELIC_STATE_BREADTH) {
    addProblem(
      problems,
      `${path} carries more than ${MAX_RELIC_STATE_BREADTH} members`
    );

    names = names.slice(0, MAX_RELIC_STATE_BREADTH);
  }

  for (const name of names) {
    if (problems.length >= MAX_REPORTED_PROBLEMS) {
      return;
    }

    const member = `${path}.${name}`;

    if (RESERVED_STATE_KEYS.has(name)) {
      addProblem(problems, `${member} is a reserved member name`);

      continue;
    }

    let descriptor: PropertyDescriptor | undefined;

    try {
      descriptor = Object.getOwnPropertyDescriptor(source, name);
    } catch {
      addProblem(problems, `${member} is not readable`);

      continue;
    }

    if (descriptor === undefined) {
      addProblem(problems, `${member} is not readable`);

      continue;
    }

    // An accessor is read by running its getter, which persistence never does;
    // the value it would produce is not stored data.
    if (
      typeof descriptor.get === 'function' ||
      typeof descriptor.set === 'function'
    ) {
      addProblem(problems, `${member} is an accessor`);

      continue;
    }

    checkRelicState(
      descriptor.value,
      member,
      problems,
      depth + 1,
      ancestors
    );
  }
}

/**
 * Reports whether `value` is one relic's persisted state: a value the
 * `PersistedRelicState` vocabulary describes.
 *
 * Decided by `checkRelicState`, so the predicate and the diagnosis can never
 * disagree about the same input. Total and non-throwing for every input.
 *
 * @param value Value as it came out of storage, parsed or otherwise.
 * @returns `true` when the value is persistable relic state.
 */
export function isPersistedRelicState(
  value: unknown
): value is PersistedRelicState {
  const problems: string[] = [];

  checkRelicState(value, 'state', problems, 0, new Set<object>());

  return problems.length === 0;
}

/**
 * The kinds a persisted `stageGoal.kind` may carry, keyed by kind so the table
 * is exhaustive over `StageGoalKind`: a kind added in
 * src/config/stage-config.ts fails to compile here until it is listed.
 */
const STAGE_GOAL_KINDS: Readonly<Record<StageGoalKind, true>> = Object.freeze({
  'highest-tile': true,
  'score-threshold': true,
});

/** Reports whether `value` is one of the declared stage goal kinds. */
function isStageGoalKind(value: unknown): value is StageGoalKind {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(STAGE_GOAL_KINDS, value)
  );
}

function addProblem(problems: string[], problem: string): void {
  if (problems.length >= MAX_REPORTED_PROBLEMS) {
    return;
  }

  if (problems.length === MAX_REPORTED_PROBLEMS - 1) {
    problems.push(PROBLEM_LIST_TRUNCATED);
    return;
  }

  problems.push(problem);
}

/**
 * Reads one member for validation, recording a problem when an accessor
 * refuses it.
 */
function readForValidation(
  source: Record<string, unknown>,
  name: string,
  path: string,
  problems: string[]
): MemberRead {
  const member = readMember(source, name);

  if (!member.readable) {
    addProblem(problems, `${path} is not readable`);
  }

  return member;
}

function checkString(
  source: Record<string, unknown>,
  name: string,
  problems: string[]
): void {
  const member = readForValidation(source, name, name, problems);

  if (member.readable && typeof member.value !== 'string') {
    addProblem(problems, `${name} is not a string`);
  }
}

/**
 * Checks the run seed against the bound the RNG layer will apply to it.
 *
 * @param source Envelope being validated.
 * @param problems List each failure is appended to.
 */
function checkRunSeed(
  source: Record<string, unknown>,
  problems: string[]
): void {
  const member = readForValidation(source, 'seed', 'seed', problems);

  if (!member.readable) {
    return;
  }

  if (typeof member.value !== 'string') {
    addProblem(problems, 'seed is not a string');
    return;
  }

  if (!isAcceptableRunSeed(member.value)) {
    addProblem(
      problems,
      `seed is longer than ${MAX_RUN_SEED_LENGTH} characters`
    );
  }
}

function checkRngCursor(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    addProblem(problems, 'rngCursor is not an object');
    return;
  }

  for (const name of RNG_STREAM_NAMES) {
    const path = `rngCursor.${name}`;
    const member = readForValidation(value, name, path, problems);

    if (member.readable && !isAcceptableRngCursor(member.value)) {
      addProblem(
        problems,
        `${path} is not an integer from 0 through ${MAX_RESUMABLE_CURSOR}`
      );
    }
  }
}

function checkStageGoal(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    addProblem(problems, 'stageGoal is not an object');
    return;
  }

  const kind = readForValidation(value, 'kind', 'stageGoal.kind', problems);

  if (kind.readable && !isStageGoalKind(kind.value)) {
    addProblem(problems, 'stageGoal.kind is not a declared stage goal kind');
  }

  const target = readForValidation(
    value,
    'target',
    'stageGoal.target',
    problems
  );

  if (target.readable && !isFiniteNumber(target.value)) {
    addProblem(problems, 'stageGoal.target is not a finite number');
  }
}

/**
 * Most values one relic state's walk visits, and most entries one array or one
 * plain object within it carries.
 */
const MAX_RELIC_STATE_NODES = 512;

/**
 * @see MAX_RELIC_STATE_NODES
 */
const MAX_RELIC_STATE_ENTRIES = 128;

const PROTOTYPE_KEY = '__proto__';

/** A remaining node allowance, decremented by each visited value. */
interface NodeBudget {
  remaining: number;
}

/**
 * Reports whether an object is plain data: its prototype is `Object.prototype`
 * or `null`, so it is neither a class instance nor a built-in such as `Date`,
 * `Map` or `Set`.
 *
 * @param value Object to test.
 * @returns `true` for a plain data object.
 */
function isPlainDataObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * Reports whether `value` is JSON data this module round-trips unchanged,
 * walking it within a fixed depth, node and entry allowance.
 *
 * @param value Value to walk.
 * @param depth Current depth.
 * @param budget Remaining node allowance, decremented per value visited.
 * @param ancestors Objects on the path from the root to `value`.
 * @returns `true` when the value is bounded JSON data.
 */
function isJsonSafeValue(
  value: unknown,
  depth: number,
  budget: NodeBudget,
  ancestors: Set<object>
): boolean {
  budget.remaining -= 1;

  if (budget.remaining < 0) {
    return false;
  }

  if (value === null) {
    return true;
  }

  const kind = typeof value;

  if (kind === 'string' || kind === 'boolean') {
    return true;
  }

  if (kind === 'number') {
    return isFiniteNumber(value);
  }

  if (kind !== 'object' || depth >= MAX_RELIC_STATE_DEPTH) {
    return false;
  }

  const container = value as object;

  if (ancestors.has(container)) {
    return false;
  }

  ancestors.add(container);

  try {
    return isJsonSafeContainer(container, depth, budget, ancestors);
  } finally {
    ancestors.delete(container);
  }
}

/**
 * Walks the entries of one array or plain data object for `isJsonSafeValue`.
 *
 * @param container Array or plain data object to walk.
 * @param depth Depth of `container` itself.
 * @param budget Remaining node allowance.
 * @param ancestors Objects on the path to `container`, including it.
 * @returns `true` when every entry is bounded JSON data.
 */
function isJsonSafeContainer(
  container: object,
  depth: number,
  budget: NodeBudget,
  ancestors: Set<object>
): boolean {
  if (Array.isArray(container)) {
    if (container.length > MAX_RELIC_STATE_ENTRIES) {
      return false;
    }

    return container.every((entry: unknown) =>
      isJsonSafeValue(entry, depth + 1, budget, ancestors)
    );
  }

  if (!isPlainDataObject(container)) {
    return false;
  }

  const keys = Object.keys(container);

  if (keys.length > MAX_RELIC_STATE_ENTRIES) {
    return false;
  }

  const entries = container as Record<string, unknown>;

  return keys.every(
    (key) =>
      key !== PROTOTYPE_KEY &&
      isJsonSafeValue(entries[key], depth + 1, budget, ancestors)
  );
}

/**
 * Reports whether a relic's opaque state is data this module persists and
 * restores unchanged.
 *
 * @param value State to test.
 * @returns `true` for bounded JSON data.
 */
function isJsonSafeRelicState(value: unknown): boolean {
  try {
    return isJsonSafeValue(
      value,
      0,
      { remaining: MAX_RELIC_STATE_NODES },
      new Set<object>()
    );
  } catch {
    return false;
  }
}

/**
 * Records a problem for every relic entry that is not `{ id, charges?, state?
 * }`, and for every part of an entry's `state` that falls outside
 * `PersistedRelicState`.
 *
 * @param value Candidate relic array.
 * @param problems List to append to.
 */
function checkRelics(value: unknown, problems: string[]): void {
  if (!Array.isArray(value)) {
    addProblem(problems, 'relics is not an array');
    return;
  }

  if (value.length > MAX_PERSISTED_RELICS) {
    addProblem(problems, `relics holds more than ${MAX_PERSISTED_RELICS}`);
    return;
  }

  for (let index = 0; index < value.length; index += 1) {
    if (problems.length >= MAX_REPORTED_PROBLEMS) {
      return;
    }

    const entry: unknown = value[index];
    const path = `relics[${index}]`;

    if (!isRecord(entry)) {
      addProblem(problems, `${path} is not an object`);
      continue;
    }

    const id = readForValidation(entry, 'id', `${path}.id`, problems);

    if (id.readable && typeof id.value !== 'string') {
      addProblem(problems, `${path}.id is not a string`);
    }

    const charges = readForValidation(
      entry,
      'charges',
      `${path}.charges`,
      problems
    );

    // Absent is the declared form of a relic with no charge budget.
    if (
      charges.readable &&
      charges.value !== undefined &&
      !isNonNegativeInteger(charges.value)
    ) {
      addProblem(problems, `${path}.charges is not a non-negative integer`);
    }

    const state = readForValidation(
      entry,
      'state',
      `${path}.state`,
      problems
    );

    // Absent is the declared form of a relic carrying no state of its own.
    if (state.readable && state.value !== undefined) {
      const reportedBefore = problems.length;

      checkRelicState(
        state.value,
        `${path}.state`,
        problems,
        0,
        new Set<object>()
      );

      // A total-value allowance the per-level depth and breadth bounds cannot
      // express between them: a payload inside both can still declare a
      // multiplicative number of values.
      if (
        problems.length === reportedBefore &&
        !isJsonSafeRelicState(state.value)
      ) {
        addProblem(
          problems,
          `${path}.state carries more than ` +
            `${MAX_RELIC_STATE_NODES} values`
        );
      }
    }
  }
}

/**
 * Records a problem for every member of a standing reward round that is not the
 * shape `PendingRewardRound` declares: a non-negative integer `stageIndex` and
 * an array of at most `MAX_REWARD_OFFER_IDS` distinct non-empty string
 * identifiers.
 *
 * DISTINCTNESS IS CHECKED HERE because the no-duplicate-offers rule is
 * structural (AAP V6): an envelope carrying the same identifier twice describes
 * an offer the seeded draw could not have produced, so it is refused at the
 * boundary rather than presented.
 *
 * The identifiers are NOT resolved against the catalogue here — this module
 * knows nothing of relics — so a round naming a relic the catalogue no longer
 * declares is structurally valid and is dropped by the projection that rebuilds
 * the offer.
 *
 * @param value Candidate round.
 * @param problems Accumulating problem list.
 */
function checkPendingReward(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    addProblem(problems, 'pendingReward is not an object');
    return;
  }

  const stageIndex = readForValidation(
    value,
    'stageIndex',
    'pendingReward.stageIndex',
    problems
  );

  if (stageIndex.readable && !isNonNegativeInteger(stageIndex.value)) {
    addProblem(
      problems,
      'pendingReward.stageIndex is not a non-negative integer'
    );
  }

  const offered = readForValidation(
    value,
    'offeredRelicIds',
    'pendingReward.offeredRelicIds',
    problems
  );

  if (!offered.readable) {
    return;
  }

  if (!Array.isArray(offered.value)) {
    addProblem(problems, 'pendingReward.offeredRelicIds is not an array');
    return;
  }

  if (offered.value.length === 0) {
    addProblem(problems, 'pendingReward.offeredRelicIds is empty');
    return;
  }

  if (offered.value.length > MAX_REWARD_OFFER_IDS) {
    addProblem(
      problems,
      `pendingReward.offeredRelicIds holds more than ${MAX_REWARD_OFFER_IDS}`
    );
    return;
  }

  const seen = new Set<string>();

  for (let index = 0; index < offered.value.length; index += 1) {
    const entry: unknown = offered.value[index];
    const path = `pendingReward.offeredRelicIds[${index}]`;

    if (typeof entry !== 'string' || entry.length === 0) {
      addProblem(problems, `${path} is not a non-empty string`);
      continue;
    }

    if (seen.has(entry)) {
      addProblem(problems, `${path} repeats an identifier already offered`);
      continue;
    }

    seen.add(entry);
  }
}

/**
 * Reports whether `value` is one persisted tile,
 * `{ position: { x, y }, value }` with finite numbers throughout. A member an
 * accessor refuses reads as no tile, so the cell is reported as neither a tile
 * nor `null` by the caller.
 */
function isSerializedTileShape(value: unknown): value is SerializedTile {
  if (!isRecord(value)) {
    return false;
  }

  try {
    const position = value.position;

    return (
      isRecord(position) &&
      isFiniteNumber(position.x) &&
      isFiniteNumber(position.y) &&
      isFiniteNumber(value.value)
    );
  } catch {
    return false;
  }
}

/**
 * Records a problem for every cell that is neither a persisted tile nor
 * `null`.
 */
function checkCellMatrix(value: unknown, problems: string[]): void {
  if (!Array.isArray(value)) {
    addProblem(problems, 'board.grid.cells is not an array');
    return;
  }

  if (value.length > MAX_SUPPORTED_BOARD_SIZE) {
    addProblem(
      problems,
      `board.grid.cells holds more than ${MAX_SUPPORTED_BOARD_SIZE} columns`
    );
    return;
  }

  for (let x = 0; x < value.length; x += 1) {
    if (problems.length >= MAX_REPORTED_PROBLEMS) {
      return;
    }

    const column: unknown = value[x];

    if (!Array.isArray(column)) {
      addProblem(problems, `board.grid.cells[${x}] is not an array`);
      continue;
    }

    if (column.length > MAX_SUPPORTED_BOARD_SIZE) {
      addProblem(
        problems,
        `board.grid.cells[${x}] holds more than ` +
          `${MAX_SUPPORTED_BOARD_SIZE} cells`
      );
      continue;
    }

    for (let y = 0; y < column.length; y += 1) {
      if (problems.length >= MAX_REPORTED_PROBLEMS) {
        return;
      }

      // js/grid.js L109 wrote `null` for an empty cell, never a hole.
      const cell: unknown = column[y];

      if (cell !== null && !isSerializedTileShape(cell)) {
        addProblem(
          problems,
          `board.grid.cells[${x}][${y}] is neither a tile nor null`
        );
      }
    }
  }
}

function checkBoardFlag(
  source: Record<string, unknown>,
  name: string,
  problems: string[]
): void {
  const path = `board.${name}`;
  const member = readForValidation(source, name, path, problems);

  if (member.readable && typeof member.value !== 'boolean') {
    addProblem(problems, `${path} is not a boolean`);
  }
}

function checkGrid(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    addProblem(problems, 'board.grid is not an object');
    return;
  }

  const size = readForValidation(value, 'size', 'board.grid.size', problems);

  if (size.readable && !isBoardSize(size.value)) {
    addProblem(
      problems,
      `board.grid.size is not an integer from 1 through ${MAX_BOARD_SIZE}`
    );
  }

  const cells = readForValidation(
    value,
    'cells',
    'board.grid.cells',
    problems
  );

  if (cells.readable) {
    checkCellMatrix(cells.value, problems);
  }
}

/**
 * Records a problem for every part of the wrapped snapshot that is not `{
 * grid, score, over, won, keepPlaying }`.
 */
function checkBoard(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    addProblem(problems, 'board is not an object');
    return;
  }

  const grid = readForValidation(value, 'grid', 'board.grid', problems);

  if (grid.readable) {
    checkGrid(grid.value, problems);
  }

  const score = readForValidation(value, 'score', 'board.score', problems);

  if (score.readable && !isFiniteNumber(score.value)) {
    addProblem(problems, 'board.score is not a finite number');
  }

  checkBoardFlag(value, 'over', problems);
  checkBoardFlag(value, 'won', problems);
  checkBoardFlag(value, 'keepPlaying', problems);
}

/**
 * Describes every member of `value` that is not the envelope this module
 * declares, one field-scoped entry per problem, and returns an empty list for
 * a valid envelope.
 *
 * Total and non-throwing for every input — `null`, `undefined`, arrays,
 * primitives and objects whose accessors throw included. At most
 * `MAX_REPORTED_PROBLEMS` entries are returned, in declaration order of the
 * members.
 */
export function describeRunStateProblems(value: unknown): string[] {
  const problems: string[] = [];

  if (!isRecord(value)) {
    problems.push('run state is not an object');
    return problems;
  }

  const version = readForValidation(
    value,
    'schemaVersion',
    'schemaVersion',
    problems
  );

  if (version.readable && !isSchemaVersion(version.value)) {
    addProblem(problems, 'schemaVersion is not an integer');
  }

  checkString(value, 'runId', problems);
  checkRunSeed(value, problems);

  const cursor = readForValidation(
    value,
    'rngCursor',
    'rngCursor',
    problems
  );

  if (cursor.readable) {
    checkRngCursor(cursor.value, problems);
  }

  const stageIndex = readForValidation(
    value,
    'stageIndex',
    'stageIndex',
    problems
  );

  if (stageIndex.readable && !isNonNegativeInteger(stageIndex.value)) {
    addProblem(problems, 'stageIndex is not a non-negative integer');
  }

  const stageGoal = readForValidation(
    value,
    'stageGoal',
    'stageGoal',
    problems
  );

  if (stageGoal.readable) {
    checkStageGoal(stageGoal.value, problems);
  }

  const goalProgress = readForValidation(
    value,
    'goalProgress',
    'goalProgress',
    problems
  );

  if (goalProgress.readable && !isUnitFraction(goalProgress.value)) {
    addProblem(problems, 'goalProgress is not a fraction within [0, 1]');
  }

  const relics = readForValidation(value, 'relics', 'relics', problems);

  if (relics.readable) {
    checkRelics(relics.value, problems);
  }

  const board = readForValidation(value, 'board', 'board', problems);

  if (board.readable) {
    checkBoard(board.value, problems);
  }

  const pending = readForValidation(
    value,
    'pendingReward',
    'pendingReward',
    problems
  );

  // ABSENT IS VALID, and is the state of every envelope written before the
  // member existed as well as of every run owing no choice.
  if (pending.readable && pending.value !== undefined) {
    checkPendingReward(pending.value, problems);
  }

  return problems;
}

/**
 * Reports whether `value` is a structurally complete envelope, decided by
 * `describeRunStateProblems` so the predicate and the diagnosis can never
 * disagree about the same input. Which versions this build accepts is a
 * separate question, answered by `classifyRunStateVersion`.
 */
export function isRunStateShape(value: unknown): value is RunState {
  return describeRunStateProblems(value).length === 0;
}

/**
 * Reports whether `value` is an envelope this build may write.
 *
 * Total and non-throwing for every input.
 *
 * @param value Value to test.
 * @returns `true` when the value is a structurally complete envelope at the
 *   current schema version.
 */
export function isCurrentRunState(value: unknown): value is RunState {
  return classifyRunStateVersion(value) === 'current' && isRunStateShape(value);
}

/**
 * What `cloneRelicState` carries in place of a value the `PersistedRelicState`
 * vocabulary does not describe: nothing at all.
 */
const OMITTED_STATE_VALUE = Symbol('run-state.omitted');

/**
 * Copies a relic's opaque state, carrying data alone.
 *
 * @param value State to copy.
 * @param depth Levels descended below the `state` member itself.
 * @param ancestors Objects on the path from `state` to `value`.
 * @returns The copy, or `OMITTED_STATE_VALUE` for a value it drops.
 */
function cloneRelicState(
  value: unknown,
  depth: number,
  ancestors: Set<object>
): unknown {
  if (value === null) {
    return null;
  }

  const type = typeof value;

  if (type === 'string' || type === 'boolean') {
    return value;
  }

  if (type === 'number') {
    return isFiniteNumber(value) ? value : OMITTED_STATE_VALUE;
  }

  if (type !== 'object') {
    return OMITTED_STATE_VALUE;
  }

  const object = value as object;

  if (
    ancestors.has(object) ||
    !isDataObject(object) ||
    depth >= MAX_RELIC_STATE_DEPTH
  ) {
    return OMITTED_STATE_VALUE;
  }

  ancestors.add(object);

  try {
    if (Array.isArray(object)) {
      return cloneRelicStateEntries(object, depth, ancestors);
    }

    return cloneRelicStateMembers(object, depth, ancestors);
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Copies one persisted state array, entry for entry.
 *
 * @param entries Array to copy.
 * @param depth Levels descended below the `state` member itself.
 * @param ancestors Objects on the path from `state` to `entries`.
 * @returns A fresh array.
 */
function cloneRelicStateEntries(
  entries: readonly unknown[],
  depth: number,
  ancestors: Set<object>
): unknown[] {
  const copy: unknown[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = cloneRelicState(entries[index], depth + 1, ancestors);

    copy.push(entry === OMITTED_STATE_VALUE ? null : entry);
  }

  return copy;
}

/**
 * Copies one persisted state object, member for member.
 *
 * @param source Object to copy.
 * @param depth Levels descended below the `state` member itself.
 * @param ancestors Objects on the path from `state` to `source`.
 * @returns A fresh object.
 */
function cloneRelicStateMembers(
  source: object,
  depth: number,
  ancestors: Set<object>
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};

  for (const name of Object.getOwnPropertyNames(source)) {
    if (RESERVED_STATE_KEYS.has(name)) {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(source, name);

    if (
      descriptor === undefined ||
      typeof descriptor.get === 'function' ||
      typeof descriptor.set === 'function'
    ) {
      continue;
    }

    const entry = cloneRelicState(descriptor.value, depth + 1, ancestors);

    if (entry === OMITTED_STATE_VALUE) {
      continue;
    }

    Object.defineProperty(copy, name, {
      value: entry,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return copy;
}

/**
 * Copies one persisted relic, omitting each optional member the original omits
 * so the copy round-trips through JSON identically.
 *
 * @param relic Relic to copy.
 * @returns A fresh relic.
 * @throws RangeError when `relic.state` nests deeper than
 *   `MAX_RELIC_STATE_DEPTH`.
 */
export function cloneRelic(relic: PersistedRelic): PersistedRelic {
  const copy: { id: string; charges?: number; state?: unknown } = {
    id: relic.id,
  };

  if (relic.charges !== undefined) {
    copy.charges = relic.charges;
  }

  if (relic.state !== undefined) {
    const state = cloneRelicState(relic.state, 0, new Set<object>());

    if (state !== OMITTED_STATE_VALUE) {
      copy.state = state;
    }
  }

  return copy;
}

export function cloneStageGoal(goal: StageGoal): StageGoal {
  switch (goal.kind) {
    case 'highest-tile':
      return { kind: 'highest-tile', target: goal.target };
    case 'score-threshold':
      return { kind: 'score-threshold', target: goal.target };
    default: {
      const unhandled: never = goal;
      return unhandled;
    }
  }
}

function cloneCell(cell: SerializedTile | null): SerializedTile | null {
  if (cell === null) {
    return null;
  }

  return {
    position: { x: cell.position.x, y: cell.position.y },
    value: cell.value,
  };
}

/**
 * Copies a board snapshot, cell by cell.
 *
 * @param board Snapshot to copy.
 * @returns A fresh snapshot sharing no object with `board`.
 */
export function cloneBoardSnapshot(
  board: LegacyBoardSnapshot,
): LegacyBoardSnapshot {
  return {
    grid: {
      size: board.grid.size,
      cells: board.grid.cells.map((column) => column.map(cloneCell)),
    },
    score: board.score,
    over: board.over,
    won: board.won,
    keepPlaying: board.keepPlaying,
  };
}

/**
 * Copies an envelope for hand-off.
 *
 * @param value Envelope to copy.
 * @returns A fresh envelope.
 * @throws RangeError when a relic's `state` nests deeper than 32 levels,
 *   which cannot be copied without sharing mutable data with the original.
 */
export function cloneRunState(value: RunState): RunState {
  const pending = clonePendingReward(value.pendingReward);

  return {
    schemaVersion: value.schemaVersion,
    runId: value.runId,
    seed: value.seed,
    rngCursor: normalizeRngCursor(value.rngCursor),
    stageIndex: value.stageIndex,
    stageGoal: cloneStageGoal(value.stageGoal),
    goalProgress: value.goalProgress,
    relics: value.relics.map(cloneRelic),
    board: cloneBoardSnapshot(value.board),

    // OMITTED RATHER THAN CARRIED AS `undefined`, so a cloned envelope has the
    // same own-property set as one with no round, and `JSON.stringify` of the
    // two produces one string.
    ...(pending === undefined ? {} : { pendingReward: pending }),
  };
}

/**
 * Copies a standing reward round, or reports its absence.
 *
 * The identifier array is rebuilt, so the copy shares nothing with the original.
 *
 * @param value Round to copy, or `undefined`.
 * @returns A fresh round, or `undefined`.
 */
export function clonePendingReward(
  value: PendingRewardRound | undefined
): PendingRewardRound | undefined {
  if (value === undefined) {
    return undefined;
  }

  return {
    stageIndex: value.stageIndex,
    offeredRelicIds: [...value.offeredRelicIds],
  };
}

/**
 * Projects an envelope onto the exact members this build writes, stamped with
 * `RUN_STATE_SCHEMA_VERSION`.
 *
 * Deep throughout, on `cloneRunState`'s terms: the cursor map is rebuilt
 * through `normalizeRngCursor`, and the goal, the relics and every cell are
 * fresh objects, so the projection shares nothing with `value`.
 *
 * @param value Envelope to project.
 * @param targetVersion Version to stamp, defaulting to
 *   `RUN_STATE_SCHEMA_VERSION`. A non-integer is ignored in favour of the
 *   default.
 * @returns A fresh envelope at the target schema version.
 */
export function projectCurrentRunState(
  value: RunState,
  targetVersion?: number
): RunState {
  const pending = clonePendingReward(value.pendingReward);

  return {
    schemaVersion: isSchemaVersion(targetVersion)
      ? targetVersion
      : RUN_STATE_SCHEMA_VERSION,
    runId: value.runId,
    seed: value.seed,
    rngCursor: normalizeRngCursor(value.rngCursor),
    stageIndex: value.stageIndex,
    stageGoal: cloneStageGoal(value.stageGoal),
    goalProgress: value.goalProgress,
    relics: value.relics.map(cloneRelic),
    board: cloneBoardSnapshot(value.board),

    // Omitted where no round stands, so an envelope owing no choice is written
    // with the member absent — which is the shape every reader, including one
    // built before the member existed, already handles.
    ...(pending === undefined ? {} : { pendingReward: pending }),
  };
}

/**
 * The finished run as data.
 *
 * Data only. No formatted text, no display string, no clipboard access and no
 * DOM: presentation, including copying the seed, belongs to the presenting
 * screen.
 */
export interface RunSummary {
  readonly runId: string;

  /** The run seed, verbatim, for a screen to display and offer for copying. */
  readonly seed: string;
  readonly score: number;
  readonly stageIndex: number;
  readonly relics: readonly PersistedRelic[];
}

/**
 * Projects an envelope to its summary. Pure, and a copy: the relics are fresh
 * objects in their original pickup order, and the seed is carried verbatim.
 */
export function summarizeRunState(state: RunState): RunSummary {
  return {
    runId: state.runId,
    seed: state.seed,
    score: state.board.score,
    stageIndex: state.stageIndex,
    relics: state.relics.map(cloneRelic),
  };
}

/**
 * The finished run as a REPORT carries it: every member of `RunSummary` except
 * the seed.
 */
export type RedactedRunSummary = Omit<RunSummary, 'seed'>;

/**
 * Removes the seed from a summary, for a report.
 *
 * Pure, and a copy: the relics are fresh objects in their original pickup
 * order.
 *
 * @param summary Summary to redact.
 * @returns The summary without its seed.
 */
export function redactRunSummary(summary: RunSummary): RedactedRunSummary {
  return {
    runId: summary.runId,
    score: summary.score,
    stageIndex: summary.stageIndex,
    relics: summary.relics.map(cloneRelic),
  };
}

/**
 * Projects an envelope to the summary a report carries.
 *
 * @param state Envelope to project.
 * @returns The summary, without the run seed.
 */
export function summarizeRunStateForReport(
  state: RunState
): RedactedRunSummary {
  return redactRunSummary(summarizeRunState(state));
}

/** How a run finished. */
export type RunOutcome = 'won' | 'lost' | 'abandoned';

export interface RunStateCorruptionReport {
  /**
   * Correlation identifier of the run that read the payload, injected into the
   * store, and absent when the store was constructed without one. The refused
   * payload's own seed is never read for it: this folder derives no identifier
   * of its own.
   */
  readonly correlationId?: CorrelationId;

  /** Storage key the payload was read from. */
  readonly key: string;
  readonly verdict: RunStateVersionVerdict;
  readonly problems: readonly string[];

  /**
   * The value a read or a parse threw, exactly as it was thrown, and absent
   * when nothing threw. The pre-migration loader's only `catch` discarded its
   * error; this member is where it goes instead.
   */
  readonly error?: unknown;
}

export interface RunStateMigrationReport {
  readonly correlationId: CorrelationId;

  /** Version the stored payload carried, absent when it carried none. */
  readonly fromVersion?: number;
  readonly toVersion: number;
}

/**
 * The three board sizes a load reconciled before the grid was rebuilt: the one
 * the snapshot recorded, the one the rules configuration declares, and the one
 * applied.
 */
export interface BoardSizeReconciliationReport {
  readonly correlationId: CorrelationId;

  /** Size recorded in `board.grid.size`. */
  readonly savedSize: number;
  readonly configuredSize: number;

  /**
   * Size the active board-mutating relics implied, and `0` when none was
   * supplied or the value supplied was not a usable edge length. It takes
   * precedence over `configuredSize`, so a report where it is above zero
   * records an override that was resolved.
   */
  readonly relicSize: number;

  /** Size the grid was rebuilt at. */
  readonly appliedSize: number;
}

export interface RunStateWriteFailureReport {
  readonly correlationId: CorrelationId;

  /** Storage key the write targeted. */
  readonly key: string;

  /**
   * Serialised size the write attempted, at two bytes per UTF-16 code unit,
   * and `0` when serialisation failed before any value existed.
   */
  readonly byteLength: number;
  readonly error: unknown;
}

/** A run that began, fresh or resumed. */
export interface RunStartedReport {
  readonly correlationId: CorrelationId;

  readonly runId: string;

  /** Stage index the run opened on. */
  readonly stageIndex: number;
  readonly resumed: boolean;

  /**
   * Whether the seed came from the player rather than being originated for
   * this run. The seed itself is not carried.
   */
  readonly seedProvided: boolean;
}

export interface StageAdvancedReport {
  readonly correlationId: CorrelationId;

  /** Index of the stage that was cleared. */
  readonly fromStageIndex: number;
  readonly toStageIndex: number;
  readonly goal: StageGoal;
}

/**
 * A loaded envelope whose relics the registry made something different of.
 *
 * Raised only when hydration actually changed the set, so a clean load reports
 * nothing. `refused` names the identifiers that did not survive, which is what
 * distinguishes a save from an older catalogue from a tampered one.
 */
export interface RelicsNormalizedReport {
  readonly correlationId: CorrelationId;

  /** How many entries the envelope carried. */
  readonly requested: number;

  /** How many the registry holds after hydration. */
  readonly restored: number;

  /**
   * Identifiers the registry refused, in the order the envelope carried them.
   */
  readonly refused: readonly string[];
}

export interface RewardOfferedReport {
  readonly correlationId: CorrelationId;

  /** Stage index the offer was drawn at. */
  readonly stageIndex: number;

  /** The identifiers offered, in the order they were drawn. */
  readonly offeredRelicIds: readonly string[];
}

/** A selection measured against the offer that was standing. */
export interface RewardDrawnReport {
  readonly correlationId: CorrelationId;

  /** Stage index the offer was made at. */
  readonly stageIndex: number;

  /**
   * The offer standing when the report was made: the identifiers admitted by
   * `recordRewardOffer`, which is empty on a refused offer and once a
   * selection has been taken on.
   */
  readonly offeredRelicIds: readonly string[];

  /**
   * The identifier the outcome concerns, VERBATIM, and absent only where the
   * OFFER itself was refused and no selection was made. It is never decorated
   * with the outcome: a consumer matching identifiers has to be able to.
   */
  readonly selectedRelicId?: string;

  /**
   * Whether the relic was taken on: registered live and appended to the run's
   * relics.
   *
   * REQUIRED. It was optional, and every writer that forgot it produced a
   * report that type-checked while saying nothing about the outcome it exists
   * to describe. A report is now unconstructible without it. DL-RUNCTL-07.
   */
  readonly accepted: boolean;

  /**
   * The step that refused an offer or a selection — `RewardRefusal` for an
   * offer or a resolution and `RewardSelectionOutcome` for a selection, both of
   * src/run/run-controller.ts. Absent EXACTLY where nothing was refused, so its
   * presence and `accepted === false` always agree.
   */
  readonly refusal?: string;
}

/**
 * A run that ended.
 *
 * The summary is REDACTED: it carries the score, the stage reached and the
 * relics collected, and not the seed. The run-summary screen reads the
 * unredacted `RunSummary` from run state instead.
 */
export interface RunEndedReport {
  readonly correlationId: CorrelationId;

  readonly outcome: RunOutcome;

  /** The finished run as data, without its seed. */
  readonly summary: RedactedRunSummary;
}

/**
 * Sink for everything this folder reports: refused payloads, migrations,
 * board-size reconciliations, failed writes and the run lifecycle.
 *
 * Every member is optional, so a consumer built without a sink, or with a
 * partial one, reports only what its sink accepts, and is constructible with
 * no arguments.
 */
export interface RunReporter {
  readonly onLoadCorrupted?: (report: RunStateCorruptionReport) => void;
  readonly onVersionMigrated?: (report: RunStateMigrationReport) => void;
  readonly onBoardSizeReconciled?: (
    report: BoardSizeReconciliationReport
  ) => void;

  readonly onWriteFailed?: (report: RunStateWriteFailureReport) => void;
  readonly onRunStarted?: (report: RunStartedReport) => void;
  readonly onStageAdvanced?: (report: StageAdvancedReport) => void;
  readonly onRewardOffered?: (report: RewardOfferedReport) => void;
  readonly onRewardDrawn?: (report: RewardDrawnReport) => void;
  readonly onRelicsNormalized?: (report: RelicsNormalizedReport) => void;
  readonly onRunEnded?: (report: RunEndedReport) => void;
}

/**
 * A fully implemented `RunReporter` that discards every report, for every
 * module in this folder constructed without one.
 */
export const NOOP_RUN_REPORTER: RunReporter = Object.freeze({
  onLoadCorrupted(): void {
    return;
  },
  onVersionMigrated(): void {
    return;
  },
  onBoardSizeReconciled(): void {
    return;
  },
  onWriteFailed(): void {
    return;
  },
  onRunStarted(): void {
    return;
  },
  onStageAdvanced(): void {
    return;
  },
  onRewardOffered(): void {
    return;
  },
  onRewardDrawn(): void {
    return;
  },
  onRunEnded(): void {
    return;
  },
});

/** Prefix every derived correlation identifier carries. */
const CORRELATION_ID_PREFIX = 'run-';

/** Separates the seed-grouping prefix from the run-instance segment. */
const CORRELATION_ID_INSTANCE_SEPARATOR = '-';

const FNV_OFFSET_BASIS = 0x811c9dc5;

const FNV_PRIME = 0x01000193;

const DJB2_BASIS = 5381;

const DJB2_MULTIPLIER = 33;

const HASH_RADIX = 36;

const HASH_WIDTH = 7;

function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }

  return hash >>> 0;
}

function djb2Hash32(text: string): number {
  let hash = DJB2_BASIS;

  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, DJB2_MULTIPLIER) + text.charCodeAt(index)) | 0;
  }

  return hash >>> 0;
}

function renderHash(hash: number): string {
  return (hash >>> 0).toString(HASH_RADIX).padStart(HASH_WIDTH, '0');
}

/**
 * Derives the run correlation identifier from the two members this envelope
 * persists.
 *
 * Neither form is unique by construction — each concatenates 32-bit hashes —
 * so distinct inputs can collide, and a consumer needing exact identity
 * compares `seed` and `runId` themselves.
 *
 * @param seed Seed of the run. Coerced with `String`, so any value is
 *   accepted and none throws.
 * @param runId Run instance identifier. Omit it, or pass an empty value, for
 *   the seed-grouping form.
 * @returns An 18-character identifier for the seed-grouping form and a
 *   26-character one for the run-instance form, non-empty for every input, the
 *   empty string included.
 */
export function runCorrelationId(seed: string, runId?: string): CorrelationId {
  const runSeed = String(seed);
  const grouped =
    CORRELATION_ID_PREFIX +
    renderHash(fnv1a32(runSeed)) +
    renderHash(djb2Hash32(runSeed));

  if (runId === undefined || String(runId) === '') {
    return grouped;
  }

  const instance = `${String(runId)}\u0000${runSeed}`;

  return `${grouped}${CORRELATION_ID_INSTANCE_SEPARATOR}${renderHash(
    fnv1a32(instance) ^ djb2Hash32(instance),
  )}`;
}
