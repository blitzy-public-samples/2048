/**
 * The versioned run-state envelope: the persisted shape of one run.
 *
 * Type declarations, constants and pure functions only. Nothing here reads
 * the DOM, touches Web Storage, performs I/O, reads a clock or consumes
 * randomness: src/run/run-state-store.ts owns persistence, and
 * src/run/run-controller.ts originates the seed and the run identifier.
 *
 * WRAPPED BOARD SNAPSHOT
 *   `RunState.board` carries the pre-migration board snapshot unchanged,
 *   in the three stages that wrote it. A tile is
 *   `{ position: { x, y }, value }` (js/tile.js L19-L27). A grid is
 *   `{ size, cells }`, indexed `cells[x][y]`, with every empty cell
 *   retained as `null` rather than compacted away (js/grid.js L102-L117,
 *   L109). The board is `{ grid, score, over, won, keepPlaying }`
 *   (js/game_manager.js L102-L110). The shape is declared once, in
 *   src/engine/types.ts, and is aliased below rather than restated.
 *
 * VERSION MEMBER
 *   The pre-migration payload carried no version, schema or checksum
 *   member, and js/local_storage_manager.js L52-L55 parsed the stored
 *   value with no guard. `schemaVersion` and `classifyRunStateVersion()`
 *   are what a loader decides against instead.
 *
 * JSON ROUND-TRIP
 *   Every member of `RunState` is JSON data: strings, finite numbers,
 *   booleans, plain objects and arrays of those. No `Date`, `Map`, `Set`,
 *   class instance or method appears anywhere in the envelope, so
 *   `JSON.parse(JSON.stringify(state))` is deep-equal to `state`.
 *
 * The reasoning behind the version member, behind wrapping the board
 * snapshot rather than reshaping it, and behind persisting the RNG cursor
 * map is recorded in docs/DECISION_LOG.md. The persisted cursor map is
 * drawn as Figure 7, "Seeded Determinism: One Run Seed Fanned into Named
 * RNG Substreams", in docs/architecture/data-flow.md.
 */

import type { StageGoal, StageGoalKind } from '../config/stage-config';
import type {
  SerializedGameState,
  SerializedGrid,
  SerializedTile,
} from '../engine/types';
import {
  RNG_STREAM_NAMES,
  type RngCursorMap,
  type StreamName,
} from '../rng/rng-streams';

/* --------------------------------------------------------------------------
 * 1. The wrapped board snapshot
 * ----------------------------------------------------------------------- */

/**
 * The board snapshot the envelope wraps, in the shape the pre-migration
 * game wrote under the `gameState` key (js/game_manager.js L102-L110).
 *
 * Declared as `SerializedGameState` in src/engine/types.ts and aliased
 * here, so this folder names the snapshot vocabulary once and the value
 * `serialize()` in src/engine/engine.ts returns is assignable to
 * `RunState.board` with no cast.
 *
 * The member name `keepPlaying` is frozen on the wire. The in-class flag
 * it projects is `continuedPlay` in src/engine/engine.ts, renamed there
 * because js/game_manager.js L24-L27 gave one name to both a method and a
 * boolean; the persisted name did not change with it, and renaming it
 * inside `board` would make a save written by the pre-migration game
 * unreadable.
 */
export type LegacyBoardSnapshot = SerializedGameState;

/**
 * The grid and tile stages of the wrapped snapshot, re-exported so this
 * folder has one import surface for the snapshot vocabulary: a grid is
 * `{ size, cells }` with `cells` indexed `cells[x][y]` and holding `null`
 * in every empty cell (js/grid.js L102-L117), and a tile is
 * `{ position: { x, y }, value }` (js/tile.js L19-L27).
 */
export type { SerializedGrid, SerializedTile };

/* --------------------------------------------------------------------------
 * 2. The envelope
 * ----------------------------------------------------------------------- */

/**
 * One held relic as the envelope persists it: identity, charges remaining
 * and the relic's own opaque state.
 *
 * The persisted form is narrower than the in-memory relic declaration: the
 * wire carries no name, description, rarity or hook table. It is declared
 * here and not imported from the relic modules: this module names no
 * relic-module type, and this folder compiles and is exercised without the
 * relic registry.
 */
export interface PersistedRelic {
  /** The relic's identifier, as its own declaration carries it. */
  readonly id: string;

  /**
   * Charges remaining. Absent on a relic that carries no charge budget,
   * and `0` on one whose budget is exhausted.
   */
  readonly charges?: number;

  /**
   * The relic's own persisted state, opaque to this module and to the
   * store. JSON data only, on the round-trip contract in the module
   * header.
   */
  readonly state?: unknown;
}

/**
 * One run as it is persisted: nine members and no others.
 *
 * Run state is separate from board state. The board snapshot composes into
 * `board` and is never flattened up to this level, so `score`, `over` and
 * `won` are read through `board`.
 */
export interface RunState {
  /**
   * Schema version of this envelope. Every envelope this build writes
   * carries `RUN_STATE_SCHEMA_VERSION`, and
   * `classifyRunStateVersion()` reduces a stored value to the verdict a
   * loader decides against.
   */
  readonly schemaVersion: number;

  /**
   * Opaque identifier of this run instance, originated by
   * src/run/run-controller.ts.
   *
   * Not derived from `seed`: two runs replaying one seed carry the same
   * `seed` and different `runId`s.
   */
  readonly runId: string;

  /**
   * The run seed, verbatim, as `SeededRng.seed` and
   * `createRngStreams(seed, …)` in src/rng/ take it. Surfaced on the run
   * summary, so it round-trips through JSON unchanged.
   */
  readonly seed: string;

  /**
   * Draw count of every named RNG substream as of this envelope.
   * `RngCursorMap` in src/rng/rng-streams.ts is this member's declared
   * shape, and `createRngStreams(seed, rngCursor)` resumes each substream
   * from it.
   */
  readonly rngCursor: RngCursorMap;

  /** Zero-based index of the stage in progress. */
  readonly stageIndex: number;

  /**
   * The stage's clear condition, carried verbatim from
   * src/config/stage-config.ts. Plain JSON data: no function, no closure
   * and no class instance, on the round-trip contract in the module
   * header.
   */
  readonly stageGoal: StageGoal;

  /**
   * Fraction of `stageGoal.target` reached: the `progress` member
   * `evaluateStageGoal()` in src/config/stage-config.ts returns, clamped
   * by it to the closed interval [0, 1] and finite. Stored as produced;
   * this module neither re-derives nor re-clamps it.
   */
  readonly goalProgress: number;

  /**
   * The relics held, in pickup order.
   *
   * Array order is the pickup order the hook bus dispatches in, so it is
   * preserved on every read and every write and is never sorted,
   * filtered or re-keyed.
   */
  readonly relics: readonly PersistedRelic[];

  /** The wrapped board snapshot. */
  readonly board: LegacyBoardSnapshot;
}

/* --------------------------------------------------------------------------
 * 3. Schema versioning
 * ----------------------------------------------------------------------- */

/** Schema version every envelope this build writes carries. */
export const RUN_STATE_SCHEMA_VERSION = 1;

/**
 * Every schema version this build can read, ascending, including
 * `RUN_STATE_SCHEMA_VERSION` itself.
 *
 * A stored version this list does not contain is `'unknown'`, which is
 * what makes the distinction between a current, an older and an
 * unreadable payload decidable rather than inferred.
 */
export const RUN_STATE_SCHEMA_VERSION_HISTORY: readonly number[] =
  Object.freeze([RUN_STATE_SCHEMA_VERSION]);

/**
 * What a stored payload's `schemaVersion` member amounts to.
 *
 * `'current'` is equal to `RUN_STATE_SCHEMA_VERSION`. `'older'` is an
 * integer in `RUN_STATE_SCHEMA_VERSION_HISTORY` below it. `'unknown'` is
 * an integer the history does not contain, which covers every integer
 * above the current version. `'absent'` is no stored value at all, or a
 * plain object carrying no `schemaVersion` member — a payload written
 * before the member existed. `'malformed'` is a `schemaVersion` that is
 * present but not an integer, and any payload that is not a plain object,
 * an array included.
 */
export type RunStateVersionVerdict =
  | 'current'
  | 'older'
  | 'unknown'
  | 'absent'
  | 'malformed';

/* --------------------------------------------------------------------------
 * 4. Shared reads and predicates
 * ----------------------------------------------------------------------- */

/** A property read, and whether an accessor refused it. */
type MemberRead =
  | { readonly readable: true; readonly value: unknown }
  | { readonly readable: false };

/**
 * Reports whether `value` is a plain object: an object that is neither
 * `null` nor an array.
 *
 * @param value Value to test.
 * @returns `true` for a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads one member of a plain object without throwing.
 *
 * A payload reaching the functions below has normally come back out of Web
 * Storage through `JSON.parse`, which produces data properties only. Every
 * function here is nonetheless total over any value a caller passes, so an
 * accessor that throws is contained and reported as an unreadable member
 * instead of escaping.
 *
 * @param source Object to read from.
 * @param name Member to read.
 * @returns The value read, or the refusal.
 */
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

/**
 * Reports whether `value` is a finite number.
 *
 * @param value Value to test.
 * @returns `true` for a number that is neither `NaN` nor an infinity.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reports whether `value` is a non-negative safe integer.
 *
 * Rejects `NaN`, both infinities, every fractional and negative value,
 * every magnitude beyond the exactly representable integer range, and
 * every value that is not a number. Draw counts, stage indices and charge
 * counts are all measured by this predicate.
 *
 * @param value Value to test.
 * @returns `true` for a non-negative safe integer.
 */
function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

/**
 * Reports whether `value` is a finite fraction within the closed interval
 * [0, 1], the range `evaluateStageGoal()` clamps `progress` to.
 *
 * @param value Value to test.
 * @returns `true` for a finite number between 0 and 1 inclusive.
 */
function isUnitFraction(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/**
 * Reports whether `value` is a usable board edge length: a safe integer
 * greater than zero, as js/grid.js L102-L117 wrote it.
 *
 * @param value Value to test.
 * @returns `true` for a positive safe integer.
 */
function isBoardSize(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

/**
 * Reports whether `value` is an integer, the only constraint a
 * `schemaVersion` member carries structurally. Which integers this build
 * accepts is `classifyRunStateVersion()`'s question, not this one's.
 *
 * @param value Value to test.
 * @returns `true` for an integer.
 */
function isSchemaVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/* --------------------------------------------------------------------------
 * 5. Version classification
 * ----------------------------------------------------------------------- */

/**
 * Reduces any stored value to the verdict a loader decides against.
 *
 * Total and non-throwing for every input, `null`, `undefined`, arrays,
 * primitives and objects whose accessors throw included: the guarded
 * loader's no-throw guarantee rests on this function, so it never throws
 * itself.
 *
 * @param value Value as it came out of storage, parsed or otherwise.
 * @returns The verdict on its `schemaVersion` member.
 */
export function classifyRunStateVersion(
  value: unknown
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

  if (version === RUN_STATE_SCHEMA_VERSION) {
    return 'current';
  }

  if (
    version < RUN_STATE_SCHEMA_VERSION &&
    RUN_STATE_SCHEMA_VERSION_HISTORY.includes(version)
  ) {
    return 'older';
  }

  return 'unknown';
}


/* --------------------------------------------------------------------------
 * 6. The RNG cursor map
 * ----------------------------------------------------------------------- */

/**
 * Reduces any value to a total cursor map.
 *
 * Walks `RNG_STREAM_NAMES` and takes one entry per name, so the result
 * carries exactly the substream names that tuple declares, in its order: a
 * name the input omits, or carries an unusable value for, is filled with
 * `0`, and a key that is not a substream name is dropped by construction.
 * An older payload written before a substream existed and a newer one
 * carrying an extra substream are therefore both readable, and
 * `createRngStreams(seed, cursors)` accepts the result as it accepts a
 * `Partial<RngCursorMap>`.
 *
 * `-0` is stored as `+0`, matching the cursor normalisation
 * `createRngStreams()` performs on restore.
 *
 * Total and non-throwing for every input.
 *
 * @param value Cursor map as it came out of a payload, or any other value.
 * @returns A fresh map carrying one non-negative safe integer per
 *   substream name.
 */
export function normalizeRngCursor(value: unknown): RngCursorMap {
  const source = isRecord(value) ? value : null;
  const cursor: Partial<Record<StreamName, number>> = {};

  for (const name of RNG_STREAM_NAMES) {
    const member = source === null ? null : readMember(source, name);
    const recorded =
      member !== null && member.readable ? member.value : undefined;

    cursor[name] =
      isNonNegativeInteger(recorded) && recorded > 0 ? recorded : 0;
  }

  // Total by construction: the loop assigns every entry of
  // RNG_STREAM_NAMES, which is the complete key set of RngCursorMap.
  return cursor as RngCursorMap;
}

/* --------------------------------------------------------------------------
 * 7. Construction
 * ----------------------------------------------------------------------- */

/** What `createFreshRunState()` assembles an envelope from. */
export interface FreshRunStateInput {
  /** Identifier of the run instance, originated by the run controller. */
  readonly runId: string;

  /** The run seed, stored verbatim. */
  readonly seed: string;

  /**
   * Draw counts to record. Passed through `normalizeRngCursor()`, so a
   * map missing a substream is completed with `0` rather than refused.
   */
  readonly rngCursor: Partial<RngCursorMap>;

  /** Zero-based index of the stage the run opens on. */
  readonly stageIndex: number;

  /** Clear condition of that stage. */
  readonly stageGoal: StageGoal;

  /** The board snapshot to wrap. */
  readonly board: LegacyBoardSnapshot;
}

/**
 * Assembles a fresh envelope.
 *
 * Pure: no I/O, no clock, no randomness, and neither the seed nor the run
 * identifier is originated here — both arrive as arguments from
 * src/run/run-controller.ts. `schemaVersion`, `goalProgress` and `relics`
 * are the three members this factory fills itself, with the current schema
 * version, no progress and no relics.
 *
 * `stageGoal` and `board` are carried by reference; `cloneRunState()` is
 * the deep copy.
 *
 * @param input Identity, seed, cursors, stage and board of the new run.
 * @returns A fresh envelope.
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


/* --------------------------------------------------------------------------
 * 8. Structural validation
 * ----------------------------------------------------------------------- */

/**
 * Most problems one diagnosis reports. A list that reaches this length
 * ends with `PROBLEM_LIST_TRUNCATED`, and the matrix and relic walks stop
 * there, so a payload carrying a large corrupt array is diagnosed in
 * bounded work and bounded output.
 */
const MAX_REPORTED_PROBLEMS = 32;

/** Final entry of a diagnosis that reached `MAX_REPORTED_PROBLEMS`. */
const PROBLEM_LIST_TRUNCATED = 'further problems were not reported';

/**
 * The kinds a persisted `stageGoal.kind` may carry, keyed by kind so the
 * table is exhaustive over `StageGoalKind`: a kind added in
 * src/config/stage-config.ts fails to compile here until it is listed.
 */
const STAGE_GOAL_KINDS: Readonly<Record<StageGoalKind, true>> = Object.freeze({
  'highest-tile': true,
  'score-threshold': true,
});

/**
 * Reports whether `value` is one of the declared stage goal kinds. Read
 * through `hasOwnProperty`, so an inherited member name such as
 * `toString` is not mistaken for a kind.
 *
 * @param value Value to test.
 * @returns `true` for a declared kind.
 */
function isStageGoalKind(value: unknown): value is StageGoalKind {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(STAGE_GOAL_KINDS, value)
  );
}

/**
 * Appends one problem, stopping at `MAX_REPORTED_PROBLEMS`.
 *
 * @param problems List to append to.
 * @param problem Field-scoped description of one problem.
 */
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
 *
 * The refusal is not discarded: it surfaces as a field-scoped entry in the
 * list a store hands to `RunReporter.onLoadCorrupted`.
 *
 * @param source Object to read from.
 * @param name Member to read.
 * @param path Dotted path the member is reported under.
 * @param problems List to append a refusal to.
 * @returns The value read, or the refusal.
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

/**
 * Records a problem unless the named member is a string.
 *
 * @param source Object to read from.
 * @param name Member to read, also its reported path.
 * @param problems List to append to.
 */
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
 * Records a problem for every substream name the cursor map does not carry
 * a usable draw count for.
 *
 * @param value Candidate cursor map.
 * @param problems List to append to.
 */
function checkRngCursor(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    addProblem(problems, 'rngCursor is not an object');
    return;
  }

  for (const name of RNG_STREAM_NAMES) {
    const path = `rngCursor.${name}`;
    const member = readForValidation(value, name, path, problems);

    if (member.readable && !isNonNegativeInteger(member.value)) {
      addProblem(problems, `${path} is not a non-negative integer`);
    }
  }
}

/**
 * Records a problem for every part of a stage goal that is not the plain
 * data src/config/stage-config.ts declares.
 *
 * @param value Candidate stage goal.
 * @param problems List to append to.
 */
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
 * Records a problem for every relic entry that is not
 * `{ id, charges?, state? }`. Entry order is read but never rearranged:
 * the index in each reported path is the relic's pickup position.
 *
 * @param value Candidate relic array.
 * @param problems List to append to.
 */
function checkRelics(value: unknown, problems: string[]): void {
  if (!Array.isArray(value)) {
    addProblem(problems, 'relics is not an array');
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
  }
}

/**
 * Reports whether `value` is one persisted tile,
 * `{ position: { x, y }, value }` with finite numbers throughout
 * (js/tile.js L19-L27).
 *
 * A member an accessor refuses reads as no tile, so the cell is reported
 * as neither a tile nor `null` by the caller.
 *
 * @param value Candidate cell.
 * @returns `true` for a persisted tile.
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
 *
 * The matrix is not required to measure `board.grid.size` by
 * `board.grid.size`: the restore in src/engine/grid.ts truncates a larger
 * matrix and fills a smaller one with empty cells, and reconciling a saved
 * size against the configured one is the store's step, reported through
 * `RunReporter.onBoardSizeReconciled`.
 *
 * @param value Candidate cell matrix.
 * @param problems List to append to.
 */
function checkCellMatrix(value: unknown, problems: string[]): void {
  if (!Array.isArray(value)) {
    addProblem(problems, 'board.grid.cells is not an array');
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

/**
 * Records a problem unless the named board member is a boolean.
 *
 * @param source Candidate board snapshot.
 * @param name Member to read.
 * @param problems List to append to.
 */
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

/**
 * Records a problem for every part of the grid stage that is not
 * `{ size, cells }` (js/grid.js L102-L117).
 *
 * @param value Candidate grid snapshot.
 * @param problems List to append to.
 */
function checkGrid(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    addProblem(problems, 'board.grid is not an object');
    return;
  }

  const size = readForValidation(value, 'size', 'board.grid.size', problems);

  if (size.readable && !isBoardSize(size.value)) {
    addProblem(problems, 'board.grid.size is not a positive integer');
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
 * Records a problem for every part of the wrapped snapshot that is not
 * `{ grid, score, over, won, keepPlaying }` (js/game_manager.js
 * L102-L110).
 *
 * @param value Candidate board snapshot.
 * @param problems List to append to.
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

  // The persisted name is frozen; src/engine/engine.ts projects its
  // `continuedPlay` flag onto it.
  checkBoardFlag(value, 'keepPlaying', problems);
}

/**
 * Describes every member of `value` that is not the envelope this module
 * declares, one field-scoped entry per problem, and returns an empty list
 * for a valid envelope.
 *
 * A store hands the result to `RunReporter.onLoadCorrupted`, so a refused
 * payload is diagnosable rather than merely rejected. The entries are
 * factual and name the member at fault; they carry no rationale.
 *
 * Total and non-throwing for every input, `null`, `undefined`, arrays,
 * primitives and objects whose accessors throw included. At most
 * `MAX_REPORTED_PROBLEMS` entries are returned.
 *
 * @param value Value as it came out of storage, parsed or otherwise.
 * @returns The problems found, in declaration order of the members.
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
  checkString(value, 'seed', problems);

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

  return problems;
}

/**
 * Reports whether `value` is a structurally complete envelope.
 *
 * Decided by `describeRunStateProblems()`, so the predicate and the
 * diagnosis can never disagree about the same input. The version this
 * build accepts is a separate question, answered by
 * `classifyRunStateVersion()`.
 *
 * Total and non-throwing for every input.
 *
 * @param value Value as it came out of storage, parsed or otherwise.
 * @returns `true` when every member is present and well typed.
 */
export function isRunStateShape(value: unknown): value is RunState {
  return describeRunStateProblems(value).length === 0;
}


/* --------------------------------------------------------------------------
 * 9. Deep copy
 * ----------------------------------------------------------------------- */

/**
 * Depth at which `cloneRelicState()` stops descending and carries the
 * remaining subtree by reference. Relic state is counters and flags, so
 * this bound is never reached by the declared data, and it keeps the copy
 * finite for a self-referential value.
 */
const MAX_RELIC_STATE_DEPTH = 8;

/**
 * Copies a relic's opaque state.
 *
 * Structural and recursive: primitives are returned as they are, arrays
 * and plain objects are rebuilt entry by entry, and anything else — and
 * anything at `MAX_RELIC_STATE_DEPTH` — is carried by reference. Neither
 * `structuredClone` nor a JSON round-trip is used; the copy throws for no
 * input and catches nothing.
 *
 * @param value State to copy.
 * @param depth Current recursion depth.
 * @returns The copy.
 */
function cloneRelicState(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (depth >= MAX_RELIC_STATE_DEPTH) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry: unknown) => cloneRelicState(entry, depth + 1));
  }

  const copy: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(value)) {
    copy[key] = cloneRelicState(entry, depth + 1);
  }

  return copy;
}

/**
 * Copies one persisted relic, omitting each optional member the original
 * omits so the copy round-trips through JSON identically.
 *
 * @param relic Relic to copy.
 * @returns A fresh relic.
 */
function cloneRelic(relic: PersistedRelic): PersistedRelic {
  const copy: { id: string; charges?: number; state?: unknown } = {
    id: relic.id,
  };

  if (relic.charges !== undefined) {
    copy.charges = relic.charges;
  }

  if (relic.state !== undefined) {
    copy.state = cloneRelicState(relic.state, 0);
  }

  return copy;
}

/**
 * Copies one stage goal, preserving the kind that discriminates it.
 *
 * @param goal Goal to copy.
 * @returns A fresh goal.
 */
function cloneStageGoal(goal: StageGoal): StageGoal {
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

/**
 * Copies one persisted tile, or passes an empty cell through as `null`
 * (js/grid.js L109).
 *
 * @param cell Cell to copy.
 * @returns A fresh tile, or `null`.
 */
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
 * Copies the wrapped board snapshot, member for member, keeping the
 * `cells[x][y]` indexing and the persisted member names.
 *
 * @param board Snapshot to copy.
 * @returns A fresh snapshot.
 */
function cloneBoardSnapshot(board: LegacyBoardSnapshot): LegacyBoardSnapshot {
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
 * Deep-copies an envelope for hand-off.
 *
 * Field-wise throughout: every member, every relic, every cell and the
 * cursor map are rebuilt, so no part of the copy is shared with the
 * original and a later mutation of either is invisible to the other. Relic
 * order is preserved. The cursor map is rebuilt through
 * `normalizeRngCursor()`, so the copy carries one draw count per substream
 * name whatever the original carried.
 *
 * @param value Envelope to copy.
 * @returns A fresh envelope.
 */
export function cloneRunState(value: RunState): RunState {
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
  };
}

/* --------------------------------------------------------------------------
 * 10. Run summary
 * ----------------------------------------------------------------------- */

/**
 * The finished run as data: what src/ui/screens/run-summary.ts renders.
 *
 * Data only. No formatted text, no display string, no clipboard access and
 * no DOM: presentation, including copying the seed, belongs to the screen.
 */
export interface RunSummary {
  /** Identifier of the run instance. */
  readonly runId: string;

  /**
   * The run seed, verbatim, for the screen to display and offer for
   * copying.
   */
  readonly seed: string;

  /** Final score, read from the wrapped board snapshot. */
  readonly score: number;

  /** Zero-based index of the stage the run reached. */
  readonly stageIndex: number;

  /** The relics collected, in pickup order, with charges remaining. */
  readonly relics: readonly PersistedRelic[];
}

/**
 * Projects an envelope to its summary.
 *
 * Pure, and a copy: the relics are fresh objects in their original pickup
 * order, and the seed is carried verbatim.
 *
 * @param state Envelope to project.
 * @returns The summary.
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


/* --------------------------------------------------------------------------
 * 11. The injected report sink
 * ----------------------------------------------------------------------- */

/** How a run finished. */
export type RunOutcome = 'won' | 'lost' | 'abandoned';

/** A stored payload a load refused, with its diagnosis. */
export interface RunStateCorruptionReport {
  /**
   * Correlation identifier of the run the payload belonged to, absent when
   * the payload was too damaged to derive one from.
   */
  readonly correlationId?: string;

  /** Storage key the payload was read from. */
  readonly key: string;

  /** `classifyRunStateVersion()`'s verdict on the payload. */
  readonly verdict: RunStateVersionVerdict;

  /** `describeRunStateProblems()`'s output, verbatim. */
  readonly problems: readonly string[];

  /**
   * The value a read or a parse threw, exactly as it was thrown, and
   * absent when nothing threw. js/local_storage_manager.js L37 discarded
   * its caught error; this member is where it goes instead.
   */
  readonly error?: unknown;
}

/** A payload read at one schema version and rewritten at another. */
export interface RunStateMigrationReport {
  readonly correlationId: string;

  /** Version the stored payload carried, absent when it carried none. */
  readonly fromVersion?: number;

  /** Version the migrated envelope carries. */
  readonly toVersion: number;
}

/**
 * The three board sizes a load reconciled before the grid was rebuilt: the
 * one the snapshot recorded, the one the rules configuration declares, and
 * the one applied.
 */
export interface BoardSizeReconciliationReport {
  readonly correlationId: string;

  /** Size recorded in `board.grid.size`. */
  readonly savedSize: number;

  /** Size the active rules configuration declares. */
  readonly configuredSize: number;

  /** Size the grid was rebuilt at. */
  readonly appliedSize: number;
}

/** A write that did not reach the store. */
export interface RunStateWriteFailureReport {
  readonly correlationId: string;

  /** Storage key the write targeted. */
  readonly key: string;

  /**
   * Serialised size the write attempted, at two bytes per UTF-16 code
   * unit, and `0` when serialisation failed before any value existed.
   */
  readonly byteLength: number;

  /** The value the write threw, exactly as it was thrown. */
  readonly error: unknown;
}

/** A run that began, fresh or resumed. */
export interface RunStartedReport {
  readonly correlationId: string;

  readonly runId: string;

  readonly seed: string;

  /** Stage index the run opened on. */
  readonly stageIndex: number;

  /** Whether a stored envelope was resumed rather than a run started. */
  readonly resumed: boolean;
}

/** A stage that gave way to the next. */
export interface StageAdvancedReport {
  readonly correlationId: string;

  /** Index of the stage that was cleared. */
  readonly fromStageIndex: number;

  /** Index of the stage being entered. */
  readonly toStageIndex: number;

  /** Clear condition of the stage being entered. */
  readonly goal: StageGoal;
}

/** One reward offer, and the relic taken from it. */
export interface RewardDrawnReport {
  readonly correlationId: string;

  /** Stage index the offer was made at. */
  readonly stageIndex: number;

  /** Identifiers offered, in the order the draw produced them. */
  readonly offeredRelicIds: readonly string[];

  /** Identifier taken, absent while the offer is still open. */
  readonly selectedRelicId?: string;
}

/** A run that ended. */
export interface RunEndedReport {
  readonly correlationId: string;

  readonly outcome: RunOutcome;

  /** The finished run as data. */
  readonly summary: RunSummary;
}

/**
 * Sink for everything this folder reports: refused payloads, migrations,
 * board-size reconciliations, failed writes and the run lifecycle.
 *
 * Injected, never imported. This module names no observability module, so
 * the logger, the metrics registry and the tracer derive their structured
 * logs, counters and spans from these reports from the outside, and a test
 * substitutes a fake sink that records them. Every member carries the run
 * correlation identifier `runCorrelationId()` derives, which is the key
 * structured logs are grouped by.
 *
 * Every member is optional, so a store or a controller built without a
 * sink, or with a partial one, reports only what its sink accepts, and both
 * are constructible with no arguments.
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

  readonly onRewardDrawn?: (report: RewardDrawnReport) => void;

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
  onRewardDrawn(): void {
    return;
  },
  onRunEnded(): void {
    return;
  },
});

/* --------------------------------------------------------------------------
 * 12. The run correlation identifier
 * ----------------------------------------------------------------------- */

/** Prefix every correlation identifier carries. */
const CORRELATION_ID_PREFIX = 'run-';

/** Separator between the two hashed inputs. */
const CORRELATION_ID_SEPARATOR = '\u0000';

/** Hexadecimal digits the digest is rendered in. */
const CORRELATION_DIGEST_DIGITS = 8;

/** Radix the digest is rendered in. */
const HEX_RADIX = 16;

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * Hashes `text` with FNV-1a, 32-bit, over its UTF-16 code units.
 *
 * Not cryptographic. It identifies a run in a log line and nothing else.
 *
 * @param text Text to hash.
 * @returns The digest as an unsigned 32-bit integer.
 */
function fnv1a32(text: string): number {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }

  return hash >>> 0;
}

/**
 * Derives the run correlation identifier the observability layer keys
 * structured logs, counters and spans on, and the value `HookDispatchContext`
 * in src/engine/hooks.ts carries as its `runId`.
 *
 * Pure and deterministic: it reads no clock, consumes no randomness and
 * holds no state, so one `(seed, runId)` pair yields one identifier on
 * every call, in every process and across module reloads. Both inputs are
 * hashed, separated by a code unit no seed carries, so two runs replaying
 * one seed are still told apart.
 *
 * @param seed The run seed.
 * @param runId Identifier of the run instance.
 * @returns The correlation identifier: the prefix and eight hexadecimal
 *   digits.
 */
export function runCorrelationId(seed: string, runId: string): string {
  const digest = fnv1a32(`${seed}${CORRELATION_ID_SEPARATOR}${runId}`);

  return (
    CORRELATION_ID_PREFIX +
    digest.toString(HEX_RADIX).padStart(CORRELATION_DIGEST_DIGITS, '0')
  );
}

