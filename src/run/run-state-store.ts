/**
 * Persistence for the versioned run-state envelope: the guarded loader,
 * version migration, board-size reconciliation and robust writes.
 *
 * Every read and every write goes through the injected persistence port,
 * so this module names no Web Storage global and runs unchanged under
 * Node. It reads no DOM, holds no clock and consumes no randomness, and
 * it neither originates a seed nor a run identifier: both arrive as
 * arguments from src/run/run-controller.ts.
 *
 * PROVENANCE
 *   js/local_storage_manager.js L52-L55 read the stored snapshot and
 *   handed it to `JSON.parse` with no guard:
 *   `return stateJSON ? JSON.parse(stateJSON) : null;`. A corrupted value
 *   therefore threw during startup. `RunStateStore.load()` replaces that
 *   read and returns a result for every input.
 *
 *   js/local_storage_manager.js L48 and L58 called `setItem` with no
 *   handler, so a failed write — an exhausted quota included — left the
 *   commit path as an exception. `RunStateStore.save()` returns `false`.
 *
 *   js/local_storage_manager.js L37 was the codebase's only `catch`, and
 *   it discarded the caught value: `catch (error) { return false; }`.
 *   Every caught value below reaches the injected `RunReporter`.
 *
 *   js/game_manager.js L40-L41 rebuilt the lattice from the size the
 *   snapshot recorded:
 *   `new Grid(previousState.grid.size, previousState.grid.cells)`.
 *   `reconcileBoardSize()` runs before any grid is constructed.
 *
 *   js/game_manager.js L85-L89 cleared the stored state when the game was
 *   over and wrote it otherwise. `clear()` and `save()` are those two
 *   branches as separate methods; src/run/run-controller.ts chooses
 *   between them.
 *
 *   js/grid.js L102-L117 wrote the grid as `{ size, cells }` indexed
 *   `cells[x][y]`, with L109 pushing `null` for an empty cell, and
 *   js/tile.js L19-L27 wrote a tile as `{ position: { x, y }, value }`.
 *   The matrix `reconcileBoardSize()` returns carries those two shapes.
 *
 * FROZEN KEYS
 *   `bestScore` and `gameState` are neither read, written nor removed
 *   here. `RUN_STATE_KEY` from src/storage/storage-keys.ts is the only
 *   key this module names, and that module is where every key is
 *   declared.
 *
 * The board-size reconciliation policy, the persisted RNG cursor and the
 * choice of the matrix index over a tile's recorded position are recorded
 * in docs/DECISION_LOG.md. The commit path that writes this envelope
 * under its namespaced key is drawn as Figure 4, "Turn Data Flow: From
 * Keystroke to Composited Frame and Persisted Run State", in
 * docs/architecture/data-flow.md.
 */

import type { RulesConfig } from '../config/rules-config';
import type {
  CellMatrix,
  SerializedGrid,
  SerializedTile,
} from '../engine/types';
import type { LocalStorageManager } from '../storage/local-storage-manager';
import {
  RUN_STATE_KEY,
  type OwnedStorageKey,
} from '../storage/storage-keys';
import {
  classifyRunStateVersion,
  cloneRunState,
  describeRunStateProblems,
  isRunStateShape,
  normalizeRngCursor,
  runCorrelationId,
  NOOP_RUN_REPORTER,
  RUN_STATE_SCHEMA_VERSION,
  RUN_STATE_SCHEMA_VERSION_HISTORY,
  type BoardSizeReconciliationReport,
  type RunReporter,
  type RunState,
  type RunStateCorruptionReport,
  type RunStateMigrationReport,
  type RunStateVersionVerdict,
  type RunStateWriteFailureReport,
} from './run-state';

/* --------------------------------------------------------------------------
 * 1. Local constants and total reads
 * ----------------------------------------------------------------------- */

/**
 * Edge length applied when neither the active relics, the rules
 * configuration nor the stored snapshot supplies a usable one. The
 * smallest value `isBoardSize()` in src/run/run-state.ts accepts.
 */
const FALLBACK_BOARD_SIZE = 1;

/**
 * Bytes per UTF-16 code unit, the measure
 * `RunStateWriteFailureReport.byteLength` carries. The same measure
 * src/storage/local-storage-manager.ts applies to a write.
 */
const BYTES_PER_UTF16_UNIT = 2;

/** Reported `error` for a write the port refused without throwing. */
const WRITE_REFUSED = 'the persistence port reported a failed write';

/** Reported `error` for a removal the port refused without throwing. */
const REMOVE_REFUSED = 'the persistence port reported a failed removal';

/** Reported `error` for an envelope refused before it reached the port. */
const ENVELOPE_REFUSED =
  'the envelope was not a structurally complete run state';

/** Reported problem for a presence check the port refused. */
const PRESENCE_CHECK_FAILED = 'the presence check on the run state threw';

/** Reported problem for a value the diagnosis itself could not read. */
const DIAGNOSIS_REFUSED = 'the stored run state could not be diagnosed';

/**
 * Correlation identifier carried by a report whose run could not be
 * identified, notably a removal, which reads no envelope.
 */
const UNIDENTIFIED_CORRELATION_ID = runCorrelationId('', '');

/**
 * The stage clear condition an envelope carries, taken from `RunState` so
 * this module names the stage configuration only through the envelope
 * that already declares it.
 */
export type PersistedStageGoal = RunState['stageGoal'];

/**
 * A caught value, boxed so a thrown `undefined` stays distinguishable
 * from no throw at all.
 */
interface CaughtError {
  readonly caught: unknown;
}

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
 * A payload reaching this module has normally come back through
 * `JSON.parse`, which produces data properties only. Every read is
 * nonetheless contained, so an accessor that throws is reported as an
 * absent member rather than escaping the loader.
 *
 * @param source Object to read from.
 * @param name Member to read.
 * @returns The value read, or `undefined` when the accessor refused it.
 */
function readSafely(source: Record<string, unknown>, name: string): unknown {
  try {
    return source[name];
  } catch {
    return undefined;
  }
}

/**
 * Reads one member of a value that may not be an object at all.
 *
 * @param source Value to read from.
 * @param name Member to read.
 * @returns The value read, or `undefined`.
 */
function readMemberOf(source: unknown, name: string): unknown {
  return isRecord(source) ? readSafely(source, name) : undefined;
}

/**
 * Reports whether `value` is a finite number, the constraint
 * `isSerializedTileShape()` in src/run/run-state.ts places on a tile's
 * coordinates and value.
 *
 * @param value Value to test.
 * @returns `true` for a number that is neither `NaN` nor an infinity.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reports whether `value` is a usable board edge length: a safe integer
 * greater than zero, matching `isBoardSize()` in src/run/run-state.ts.
 *
 * @param value Value to test.
 * @returns `true` for a positive safe integer.
 */
function isBoardEdgeLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Reads a value's `seed` and `runId` members and derives the correlation
 * identifier from them, substituting the empty string for a member that
 * is absent or is not a string.
 *
 * Total: it reads through `readSafely()` and `runCorrelationId()` is
 * pure, so it throws for no input, a malformed envelope included.
 *
 * @param value Candidate envelope.
 * @returns The correlation identifier.
 */
function correlationIdOf(value: unknown): string {
  const seed = readMemberOf(value, 'seed');
  const runId = readMemberOf(value, 'runId');

  return runCorrelationId(
    typeof seed === 'string' ? seed : '',
    typeof runId === 'string' ? runId : ''
  );
}

/**
 * Derives the correlation identifier from the first source carrying both
 * a string `seed` and a string `runId`.
 *
 * @param value Candidate envelope, preferred when it carries both.
 * @param fallback Identity supplied by the caller.
 * @returns The identifier, or `undefined` when neither source carries a
 *   complete pair.
 */
function resolveCorrelationId(
  value: unknown,
  fallback: RunStateLoadOptions
): string | undefined {
  const seed = readMemberOf(value, 'seed');
  const runId = readMemberOf(value, 'runId');

  if (typeof seed === 'string' && typeof runId === 'string') {
    return runCorrelationId(seed, runId);
  }

  if (typeof fallback.seed === 'string' && typeof fallback.runId === 'string') {
    return runCorrelationId(fallback.seed, fallback.runId);
  }

  return undefined;
}

/**
 * Diagnoses a value without throwing, even when the diagnosis itself is
 * refused by an accessor that fails on a second read.
 *
 * @param value Value to diagnose.
 * @returns `describeRunStateProblems()`'s output, or a single entry
 *   recording that the diagnosis could not be completed.
 */
function diagnose(value: unknown): string[] {
  try {
    return describeRunStateProblems(value);
  } catch {
    return [DIAGNOSIS_REFUSED];
  }
}

/**
 * Classifies a value's schema version without throwing.
 *
 * @param value Value to classify.
 * @returns The verdict, or `'malformed'` when the classification itself
 *   was refused.
 */
function classify(value: unknown): RunStateVersionVerdict {
  try {
    return classifyRunStateVersion(value);
  } catch {
    return 'malformed';
  }
}

/**
 * Measures the JSON serialisation of `value` in bytes, at two per UTF-16
 * code unit.
 *
 * @param value Value to measure.
 * @returns The byte length, or `0` when `value` serialises to no JSON
 *   text — a circular structure, `undefined`, a function or a symbol.
 */
function measureJsonBytes(value: unknown): number {
  try {
    const json: string | undefined = JSON.stringify(value);

    return json === undefined ? 0 : json.length * BYTES_PER_UTF16_UNIT;
  } catch {
    return 0;
  }
}

/* --------------------------------------------------------------------------
 * 2. The persistence port
 * ----------------------------------------------------------------------- */

/**
 * The four members of src/storage/local-storage-manager.ts this module
 * calls, as a structural port.
 *
 * Declared here, on the `BestScorePort` precedent in
 * src/engine/types.ts. `LocalStorageManager` satisfies it structurally,
 * and a unit test drives the store with a four-method object and no
 * mocking library. Recorded in docs/DECISION_LOG.md.
 *
 * `readRaw` powers `exists()` and separates an absent key from a stored
 * value that is not valid JSON, which `readJson` alone reports
 * identically as `null`. `readJson` supplies the guarded parse.
 * `writeJson` and `removeRaw` report failure by return value.
 */
export interface RunStatePersistencePort {
  /**
   * Reads the raw string stored under `key`.
   *
   * @param key Key to read.
   * @returns The stored string, or `null` when the key is absent or the
   *   read failed.
   */
  readRaw(key: OwnedStorageKey): string | null;

  /**
   * Reads and parses the JSON stored under `key`, guarding the parse.
   *
   * @param key Key to read.
   * @returns The parsed value, or `null` when the key is absent, holds
   *   an empty string, or holds text that is not valid JSON.
   */
  readJson(key: OwnedStorageKey): unknown;

  /**
   * Serialises `value` and writes it under `key`.
   *
   * @param key Key to write.
   * @param value Value to serialise.
   * @returns `true` when the serialisation and the write both succeeded.
   */
  writeJson(key: OwnedStorageKey, value: unknown): boolean;

  /**
   * Removes `key`.
   *
   * @param key Key to remove.
   * @returns `true` when the removal succeeded.
   */
  removeRaw(key: OwnedStorageKey): boolean;
}

/** Constrains its parameter to `true`, failing to compile otherwise. */
type Assert<T extends true> = T;

/**
 * Compile-time check that src/storage/local-storage-manager.ts satisfies
 * `RunStatePersistencePort`. A signature drift on either side makes this
 * alias `Assert<false>`, which does not compile.
 */
export type LocalStorageManagerSatisfiesPort = Assert<
  LocalStorageManager extends RunStatePersistencePort ? true : false
>;

/**
 * A fully implemented port that stores nothing, for a store constructed
 * without one. A read reports an absent key, a write reports failure, and
 * a removal succeeds — the semantics
 * src/storage/local-storage-manager.ts gives a removal of a key that was
 * never written.
 *
 * The counterpart of `NOOP_RUN_REPORTER` in src/run/run-state.ts.
 */
export const NULL_PERSISTENCE_PORT: RunStatePersistencePort = Object.freeze({
  readRaw(): string | null {
    return null;
  },
  readJson(): unknown {
    return null;
  },
  writeJson(): boolean {
    return false;
  },
  removeRaw(): boolean {
    return true;
  },
});

/* --------------------------------------------------------------------------
 * 3. Board-size reconciliation
 * ----------------------------------------------------------------------- */

/** What a reconciliation did to the stored matrix. */
export type BoardSizeReconciliationAction =
  /** The stored matrix already measured the applied size throughout. */
  | 'none'
  /** The applied size exceeds the size the snapshot recorded. */
  | 'grew'
  /** The applied size falls below the size the snapshot recorded. */
  | 'shrank'
  /**
   * The applied size equals the recorded size, and the stored matrix
   * still had to be rebuilt: it did not measure that size, held a cell
   * that was neither a tile nor `null`, held a hole where js/grid.js L109
   * wrote `null`, or held a tile whose recorded position disagreed with
   * the cell it occupied.
   */
  | 'repaired';

/** The three sizes a reconciliation weighed, and what it did. */
export interface BoardSizeReconciliation {
  /**
   * Edge length the snapshot recorded in `board.grid.size`, falling back
   * to the outer length of the stored matrix when that member is not a
   * positive safe integer, and `0` when neither is usable.
   */
  readonly savedSize: number;

  /**
   * Edge length the live rules configuration declares, and `0` when no
   * configuration was supplied.
   */
  readonly configuredSize: number;

  /** Edge length the returned matrix measures. A positive integer. */
  readonly appliedSize: number;

  /** What the reconciliation did. */
  readonly action: BoardSizeReconciliationAction;

  /**
   * Count of tiles that lay outside the applied bounds and were dropped.
   * A cell that was not a tile at all is not counted here; it sets
   * `action` to `'repaired'`.
   */
  readonly tilesDropped: number;
}

/**
 * A `BoardSizeReconciliation` addressed to a `RunReporter`.
 *
 * Extends `BoardSizeReconciliationReport`, so it is accepted by
 * `RunReporter.onBoardSizeReconciled` while also carrying the action and
 * the dropped count.
 */
export interface BoardSizeReconciliationDetail
  extends BoardSizeReconciliationReport,
    BoardSizeReconciliation {}

/** What `reconcileBoardSize()` weighs. */
export interface BoardSizeReconciliationInput {
  /**
   * `board.grid` exactly as it came out of storage. Untrusted: any value
   * is accepted, and one that is not `{ size, cells }` yields an empty
   * lattice at the applied size.
   */
  readonly savedGrid: unknown;

  /**
   * `RulesConfig.boardSize` of the live configuration. Ignored when it is
   * not a positive safe integer.
   */
  readonly configuredSize?: number;

  /**
   * Edge length the active board-mutating relics imply, which takes
   * precedence over `configuredSize`. Ignored when it is not a positive
   * safe integer. Supplied by the caller; this module names no
   * relic-module type. Recorded in docs/DECISION_LOG.md.
   */
  readonly relicBoardSize?: number;
}

/** What `reconcileBoardSize()` produces. */
export interface BoardSizeReconciliationResult {
  /**
   * The reconciled grid. `size` equals `reconciliation.appliedSize`,
   * `cells` measures exactly that size on both axes, every empty cell is
   * `null`, and every retained tile's `position` is the cell it occupies.
   */
  readonly grid: SerializedGrid;

  /** What the reconciliation weighed and did. */
  readonly reconciliation: BoardSizeReconciliation;
}

/** One tile read out of a stored cell, with the coordinates it recorded. */
interface ReadTile {
  /** The tile's value, carried through unchanged. */
  readonly value: number;

  /** The `position.x` the cell recorded. */
  readonly recordedX: number;

  /** The `position.y` the cell recorded. */
  readonly recordedY: number;
}

/**
 * Reads one stored cell as a tile.
 *
 * Applies the same three conditions as `isSerializedTileShape()` in
 * src/run/run-state.ts — a plain object, a plain `position` with finite
 * `x` and `y`, and a finite `value` — so a cell this function refuses is
 * exactly a cell that module would report as neither a tile nor `null`.
 *
 * @param cell Stored cell.
 * @returns The tile, or `null` when the cell is not one.
 */
function readTile(cell: unknown): ReadTile | null {
  if (!isRecord(cell)) {
    return null;
  }

  const position = readSafely(cell, 'position');

  if (!isRecord(position)) {
    return null;
  }

  const recordedX = readSafely(position, 'x');
  const recordedY = readSafely(position, 'y');
  const value = readSafely(cell, 'value');

  if (
    !isFiniteNumber(recordedX) ||
    !isFiniteNumber(recordedY) ||
    !isFiniteNumber(value)
  ) {
    return null;
  }

  return { value, recordedX, recordedY };
}

/**
 * Builds an empty square matrix of `null`, in the shape js/grid.js
 * L102-L117 wrote and js/grid.js L109 filled empty cells with.
 *
 * @param size Edge length. A positive integer.
 * @returns A fresh `size` by `size` matrix.
 */
function emptyMatrix(size: number): CellMatrix<SerializedTile> {
  const cells: CellMatrix<SerializedTile> = [];

  for (let x = 0; x < size; x += 1) {
    const column: (SerializedTile | null)[] = [];

    for (let y = 0; y < size; y += 1) {
      column.push(null);
    }

    cells.push(column);
  }

  return cells;
}

/**
 * Reconciles the size a snapshot recorded, the size the rules
 * configuration declares and the size the active board-mutating relics
 * imply, and rebuilds the cell matrix at the result.
 *
 * js/game_manager.js L40-L41 passed the recorded size and the stored
 * matrix straight to the grid constructor. js/grid.js L21-L34 then read
 * `state[x][y]` for every `x` below that size with no guard, so a
 * recorded size above the matrix's own length threw and one below it
 * dropped the outer columns without a signal. This function runs before
 * any grid is constructed and leaves neither outcome reachable.
 *
 * Pure and total: it reads no storage, invokes no reporter, mutates
 * neither argument nor any shared value, and throws for no input. The
 * caller reports the record it returns.
 *
 * Guaranteed for every input:
 *
 * - `appliedSize` is a positive safe integer.
 * - `grid.size` equals `appliedSize`.
 * - `grid.cells` has exactly `appliedSize` columns, each of exactly
 *   `appliedSize` cells.
 * - Every cell is `null` or a tile.
 * - Every retained tile's `position` is the cell it occupies, so both
 *   coordinates lie within `[0, appliedSize)`.
 * - A tile inside the applied bounds keeps the exact cell it occupied in
 *   the stored matrix; no tile is reindexed or compacted.
 * - A tile outside the applied bounds is dropped and counted in
 *   `tilesDropped`.
 *
 * @param input The stored grid and the two candidate sizes.
 * @returns The reconciled grid and the record of what was done.
 */
export function reconcileBoardSize(
  input: BoardSizeReconciliationInput
): BoardSizeReconciliationResult {
  const rawSize = readMemberOf(input.savedGrid, 'size');
  const rawCells = readMemberOf(input.savedGrid, 'cells');

  // `Array.isArray` widens an unknown to `any[]`; the annotation narrows
  // every later element read back to `unknown`.
  const columns: readonly unknown[] | null = Array.isArray(rawCells)
    ? rawCells
    : null;

  const matrixSize =
    columns !== null && isBoardEdgeLength(columns.length) ? columns.length : 0;
  const savedSize = isBoardEdgeLength(rawSize) ? rawSize : matrixSize;
  const configuredSize = isBoardEdgeLength(input.configuredSize)
    ? input.configuredSize
    : 0;
  const relicSize = isBoardEdgeLength(input.relicBoardSize)
    ? input.relicBoardSize
    : 0;

  let appliedSize = FALLBACK_BOARD_SIZE;

  if (relicSize > 0) {
    appliedSize = relicSize;
  } else if (configuredSize > 0) {
    appliedSize = configuredSize;
  } else if (savedSize > 0) {
    appliedSize = savedSize;
  }

  const cells = emptyMatrix(appliedSize);
  let tilesDropped = 0;

  // Set when the stored matrix did not already measure `savedSize` with a
  // tile or `null` in every cell and every tile in the cell it recorded.
  let repaired = false;

  if (columns === null) {
    // A grid carrying no matrix at all is not an inconsistency to repair
    // unless it carried something in that member's place.
    repaired = rawCells !== undefined;
  } else {
    if (columns.length !== savedSize) {
      repaired = true;
    }

    for (let x = 0; x < columns.length; x += 1) {
      const sourceColumn: unknown = columns[x];

      if (!Array.isArray(sourceColumn)) {
        repaired = true;
        continue;
      }

      const column: readonly unknown[] = sourceColumn;

      if (column.length !== savedSize) {
        repaired = true;
      }

      for (let y = 0; y < column.length; y += 1) {
        const cell: unknown = column[y];

        if (cell === null) {
          continue;
        }

        if (cell === undefined) {
          // js/grid.js L109 wrote `null`, never a hole.
          repaired = true;
          continue;
        }

        const tile = readTile(cell);

        if (tile === null) {
          repaired = true;
          continue;
        }

        if (x >= appliedSize || y >= appliedSize) {
          tilesDropped += 1;
          continue;
        }

        if (tile.recordedX !== x || tile.recordedY !== y) {
          repaired = true;
        }

        const target = cells[x];

        if (target !== undefined) {
          target[y] = { position: { x, y }, value: tile.value };
        }
      }
    }
  }

  let action: BoardSizeReconciliationAction = 'none';

  if (appliedSize > savedSize) {
    action = 'grew';
  } else if (appliedSize < savedSize) {
    action = 'shrank';
  } else if (repaired || tilesDropped > 0) {
    action = 'repaired';
  }

  return {
    // Member order matches js/grid.js L113-L116.
    grid: { size: appliedSize, cells },
    reconciliation: {
      savedSize,
      configuredSize,
      appliedSize,
      action,
      tilesDropped,
    },
  };
}

/* --------------------------------------------------------------------------
 * 4. Version migration and legacy tolerance
 * ----------------------------------------------------------------------- */

/**
 * The identity a migrated envelope adopts when the stored payload carries
 * none of its own.
 *
 * Supplied by src/run/run-controller.ts, which is where a seed and a run
 * identifier are originated. Nothing in this module mints either.
 */
export interface RunStateMigrationIdentity {
  /** Identifier of the run instance. */
  readonly runId: string;

  /** The run seed, stored verbatim. */
  readonly seed: string;

  /** Clear condition of the stage the migrated run opens on. */
  readonly stageGoal: PersistedStageGoal;
}

/**
 * An envelope assembled from a stored payload but not yet validated.
 *
 * Typed `Record<string, unknown>`: `reconcileBoardSize()` runs between
 * the assembly and the validation, and until `isRunStateShape()` has
 * passed the value is not a `RunState`.
 */
type RunStateCandidate = Record<string, unknown>;

/** Member name each board snapshot stage is read and written under. */
const BOARD_MEMBERS = ['grid', 'score', 'over', 'won', 'keepPlaying'] as const;

/**
 * Copies the five members of a board snapshot, in the order
 * js/game_manager.js L103-L109 wrote them, so a payload round-trips
 * through this module byte for byte.
 *
 * A wrap, never a reshape: each member is carried through by value with no
 * renaming and no coercion. `keepPlaying` keeps that exact name.
 *
 * @param value Candidate board snapshot.
 * @returns The copy, or `value` unchanged when it is not a plain object,
 *   in which case validation refuses it.
 */
function boardCandidate(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const board: Record<string, unknown> = {};

  for (const name of BOARD_MEMBERS) {
    board[name] = readSafely(value, name);
  }

  return board;
}

/**
 * Assembles a candidate from a stored envelope, stamping the current
 * schema version.
 *
 * `rngCursor` passes through `normalizeRngCursor()`, so a cursor map
 * missing a substream name, carrying an unusable draw count, or carrying
 * a name this build does not know is completed rather than refused.
 *
 * @param value Stored envelope.
 * @returns The candidate, or `null` when `value` is not a plain object.
 */
function envelopeCandidate(value: unknown): RunStateCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: readSafely(value, 'runId'),
    seed: readSafely(value, 'seed'),
    rngCursor: normalizeRngCursor(readSafely(value, 'rngCursor')),
    stageIndex: readSafely(value, 'stageIndex'),
    stageGoal: readSafely(value, 'stageGoal'),
    goalProgress: readSafely(value, 'goalProgress'),
    relics: readSafely(value, 'relics'),
    board: boardCandidate(readSafely(value, 'board')),
  };
}

/**
 * Reads a stored `schemaVersion` member as an integer.
 *
 * @param value Stored payload.
 * @returns The version, or `undefined` when the member is absent or is
 *   not an integer.
 */
function readStoredVersion(value: unknown): number | undefined {
  const stored = readMemberOf(value, 'schemaVersion');

  return typeof stored === 'number' && Number.isInteger(stored)
    ? stored
    : undefined;
}

/**
 * Assembles a candidate from an envelope stored at an earlier schema
 * version.
 *
 * The stored version is re-read here and checked against
 * `RUN_STATE_SCHEMA_VERSION_HISTORY`, not taken from the verdict:
 * `migrateRunState()` is exported, and a caller may pass a verdict that
 * was not derived from the value it accompanies. A version the history
 * does not list is refused here as it is by `classifyRunStateVersion()`.
 *
 * The upgrade is a re-stamp: the envelope is assembled at the current
 * shape and given the current version, then validated by the caller. A
 * future schema version whose members differ adds its own branch to this
 * function; `load()` is keyed on the verdict alone and does not change
 * with it. Recorded in docs/DECISION_LOG.md.
 *
 * @param value Stored envelope.
 * @returns The candidate, or `null` when the stored version is not one
 *   this build reads.
 */
function olderEnvelopeCandidate(value: unknown): RunStateCandidate | null {
  const version = readStoredVersion(value);

  if (
    version === undefined ||
    !RUN_STATE_SCHEMA_VERSION_HISTORY.includes(version)
  ) {
    return null;
  }

  return envelopeCandidate(value);
}

/**
 * Assembles a candidate from a payload carrying no `schemaVersion` member
 * at all.
 *
 * Two payloads reach this: an envelope written under the run key before
 * the version member existed, which carries `board`, and a board snapshot
 * written by the pre-migration game, which carries `grid` at the top level
 * (js/game_manager.js L102-L110). The first is re-stamped; the second is
 * wrapped into a version-1 envelope whose `board` is the payload's own
 * five members, whose `stageIndex` and `goalProgress` are `0`, whose
 * `relics` is empty, whose `rngCursor` is zeroed, and whose `runId`,
 * `seed` and `stageGoal` come from the caller.
 *
 * @param value Stored payload.
 * @param identity Identity the wrap adopts.
 * @returns The candidate, or `null` when the payload is neither shape, or
 *   when a wrap is needed and no identity was supplied.
 */
function unversionedCandidate(
  value: unknown,
  identity: RunStateMigrationIdentity | undefined
): RunStateCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  if (isRecord(readSafely(value, 'board'))) {
    return envelopeCandidate(value);
  }

  if (identity === undefined || !isRecord(readSafely(value, 'grid'))) {
    return null;
  }

  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: identity.runId,
    seed: identity.seed,
    rngCursor: normalizeRngCursor(undefined),
    stageIndex: 0,
    stageGoal: identity.stageGoal,
    goalProgress: 0,
    relics: [],
    board: boardCandidate(value),
  };
}

/**
 * Assembles a candidate for one verdict.
 *
 * The chain is keyed on the verdict, so a schema version added to
 * `RUN_STATE_SCHEMA_VERSION_HISTORY` is absorbed by
 * `olderEnvelopeCandidate()` without a change here or in `load()`.
 *
 * @param value Stored payload.
 * @param verdict `classifyRunStateVersion()`'s verdict on it.
 * @param identity Identity a wrap adopts.
 * @returns The candidate, or `null` when the payload cannot be migrated.
 */
function toRunStateCandidate(
  value: unknown,
  verdict: RunStateVersionVerdict,
  identity: RunStateMigrationIdentity | undefined
): RunStateCandidate | null {
  switch (verdict) {
    case 'current':
      return envelopeCandidate(value);
    case 'older':
      return olderEnvelopeCandidate(value);
    case 'absent':
      return unversionedCandidate(value, identity);
    case 'unknown':
    // A payload from a newer build is not salvaged: its members are not
    // this build's members, and a partial read would half-load a run.
    case 'malformed':
      return null;
    default: {
      const unhandled: never = verdict;

      return unhandled;
    }
  }
}

/**
 * Migrates a stored payload to a validated envelope at the current schema
 * version.
 *
 * Pure: no storage, no reporter, no clock, no randomness, and neither
 * argument is mutated. Neither a seed nor a run identifier is originated;
 * a payload that needs one and is given no `identity` is refused.
 *
 * `RunStateStore.load()` composes the same assembly step with
 * `reconcileBoardSize()` between the assembly and the validation, so a
 * stored matrix whose dimensions disagree with its recorded size is
 * repaired rather than refused. Called directly, this function validates
 * the payload's matrix as stored.
 *
 * @param value Stored payload, parsed or otherwise.
 * @param verdict `classifyRunStateVersion()`'s verdict on it.
 * @param identity Identity a wrap of an unversioned board snapshot
 *   adopts. Not read for a payload that carries its own.
 * @returns A validated envelope carrying `RUN_STATE_SCHEMA_VERSION`, or
 *   `null` when the payload is not migratable.
 */
export function migrateRunState(
  value: unknown,
  verdict: RunStateVersionVerdict,
  identity?: RunStateMigrationIdentity
): RunState | null {
  const candidate = toRunStateCandidate(value, verdict, identity);

  if (candidate === null || !isRunStateShape(candidate)) {
    return null;
  }

  return cloneRunState(candidate);
}

/* --------------------------------------------------------------------------
 * 5. The load result
 * ----------------------------------------------------------------------- */

/** What one load amounted to. */
export type RunStateLoadOutcome =
  /** A stored envelope at the current version was returned unchanged. */
  | 'loaded'
  /** A stored payload was migrated to the current version. */
  | 'migrated'
  /**
   * A stored payload was returned with its board size reconciled, whether
   * or not it was also migrated. Takes precedence over `'migrated'` and
   * `'loaded'`; `reconciliation.action` distinguishes the three cases it
   * covers.
   */
  | 'reconciled'
  /**
   * The stored payload was refused. `state` is `null` and `problems`
   * carries the diagnosis; the caller starts a fresh run, which is where
   * a seed and a run identifier are originated.
   */
  | 'fresh-fallback'
  /** No value was stored. `state` is `null` and nothing was refused. */
  | 'absent';

/** What one load produced. */
export interface RunStateLoadResult {
  /**
   * The resolved envelope, or `null` on `'absent'` and
   * `'fresh-fallback'`. Deep-copied, so the caller holds nothing the
   * store or the stored payload also holds.
   */
  readonly state: RunState | null;

  /**
   * `classifyRunStateVersion()`'s verdict on the value that was stored,
   * not on whatever intermediate value a refusal diagnosed.
   */
  readonly verdict: RunStateVersionVerdict;

  /** What the load amounted to. */
  readonly outcome: RunStateLoadOutcome;

  /**
   * The record of the board-size reconciliation, present whenever one
   * ran — including when it changed nothing, where `action` is `'none'`.
   * Absent on `'absent'`, and on a refusal that happened before the
   * reconciliation could run.
   */
  readonly reconciliation?: BoardSizeReconciliation;

  /**
   * `describeRunStateProblems()`'s diagnosis of the refused value,
   * present on `'fresh-fallback'` alone.
   */
  readonly problems?: readonly string[];
}

/** What one load reads besides the stored payload. */
export interface RunStateLoadOptions {
  /**
   * Run identifier a wrap of an unversioned board snapshot adopts.
   * Originated by src/run/run-controller.ts. A wrap is refused when this,
   * `seed` or `stageGoal` is missing.
   */
  readonly runId?: string;

  /** Run seed a wrap adopts, stored verbatim. */
  readonly seed?: string;

  /** Stage clear condition a wrap adopts. */
  readonly stageGoal?: PersistedStageGoal;

  /**
   * Edge length to reconcile against, overriding the injected
   * configuration's `boardSize` for this load.
   */
  readonly boardSize?: number;

  /** Edge length the active board-mutating relics imply. */
  readonly relicBoardSize?: number;
}

/**
 * Assembles the migration identity from load options, which carry each
 * member optionally.
 *
 * @param options Load options.
 * @returns The identity, or `undefined` when any member is missing.
 */
function identityFrom(
  options: RunStateLoadOptions
): RunStateMigrationIdentity | undefined {
  const { runId, seed, stageGoal } = options;

  if (
    typeof runId !== 'string' ||
    typeof seed !== 'string' ||
    stageGoal === undefined
  ) {
    return undefined;
  }

  return { runId, seed, stageGoal };
}

/* --------------------------------------------------------------------------
 * 6. The store
 * ----------------------------------------------------------------------- */

/** A `RunStateCorruptionReport` under assembly. */
type MutableCorruptionReport = {
  -readonly [K in keyof RunStateCorruptionReport]: RunStateCorruptionReport[K];
};

/** What a `RunStateStore` is constructed from. Every member is optional. */
export interface RunStateStoreOptions {
  /**
   * Where the envelope is persisted. Defaults to
   * `NULL_PERSISTENCE_PORT`, so a store is constructible with no
   * arguments and holds nothing until one is supplied.
   */
  readonly storage?: RunStatePersistencePort;

  /**
   * Where refusals, migrations, reconciliations and failed writes are
   * reported. Defaults to `NOOP_RUN_REPORTER`. Injected, never imported:
   * this module names no observability module.
   */
  readonly reporter?: RunReporter;

  /**
   * The live rules configuration, read for `boardSize` alone and read at
   * each load rather than copied, so a board-mutating relic that
   * reconciles `boardSize` for a run is seen on the next load.
   */
  readonly config?: RulesConfig;
}

/**
 * Reads and writes the versioned run-state envelope under
 * `RUN_STATE_KEY`.
 *
 * `load()`, `save()`, `clear()` and `exists()` return rather than throw,
 * for every input and against any port. `bestScore` and `gameState` are
 * neither read, written nor removed.
 */
export class RunStateStore {
  /** Where the envelope is persisted. */
  private readonly storage: RunStatePersistencePort;

  /** Where this store reports. */
  private readonly reporter: RunReporter;

  /** The live rules configuration, held by reference. */
  private readonly config: RulesConfig | undefined;

  /**
   * @param options Port, reporter and configuration, each optional.
   */
  constructor(options: RunStateStoreOptions = {}) {
    this.storage = options.storage ?? NULL_PERSISTENCE_PORT;
    this.reporter = options.reporter ?? NOOP_RUN_REPORTER;
    this.config = options.config;
  }

  /**
   * Reads the stored envelope, migrating and reconciling it as needed.
   *
   * Never throws, for any stored value and against any port. The read at
   * js/local_storage_manager.js L52-L55 parsed the stored value with no
   * guard, so a corrupted entry threw during startup; every failure here
   * is caught, reported through the injected `RunReporter` with the
   * verdict, the diagnosis and the caught value, and returned as a
   * `'fresh-fallback'` result.
   *
   * The read is wrapped here as well as in the port's own guarded parse:
   * a member read that an accessor refuses during validation or copying
   * is caught at this level.
   *
   * @param options Identity a wrap adopts, and the sizes to reconcile
   *   against.
   * @returns The resolved envelope, or the outcome that refused it.
   */
  load(options: RunStateLoadOptions = {}): RunStateLoadResult {
    let observed: unknown;

    try {
      const raw = this.storage.readRaw(RUN_STATE_KEY);

      if (raw === null || raw.length === 0) {
        // Nothing was stored, so nothing was refused and nothing is
        // reported: a first load on a clean origin is not a corruption.
        return { state: null, verdict: 'absent', outcome: 'absent' };
      }

      observed = this.storage.readJson(RUN_STATE_KEY);

      return this.resolve(observed, options);
    } catch (error) {
      return this.refuse(classify(observed), observed, undefined, options, {
        caught: error,
      });
    }
  }

  /**
   * Writes `state` under `RUN_STATE_KEY`.
   *
   * js/local_storage_manager.js L48 and L58 called `setItem` with no
   * handler, so an exhausted quota left the commit path as an exception.
   * A refused or failed write is reported through the injected
   * `RunReporter` and returned as `false`.
   *
   * A malformed envelope is refused before the port is touched, so a
   * value that could not be read back is never stored.
   *
   * The counterpart of `clear()`: js/game_manager.js L85-L89 cleared the
   * stored state when the game was over and wrote it otherwise, and
   * src/run/run-controller.ts makes that choice.
   *
   * @param state Envelope to persist.
   * @returns `true` when the write reached the store.
   */
  save(state: RunState): boolean {
    try {
      if (!isRunStateShape(state)) {
        this.reportWriteFailure(state, ENVELOPE_REFUSED);

        return false;
      }

      if (!this.storage.writeJson(RUN_STATE_KEY, state)) {
        this.reportWriteFailure(state, WRITE_REFUSED);

        return false;
      }

      return true;
    } catch (error) {
      this.reportWriteFailure(state, error);

      return false;
    }
  }

  /**
   * Removes the stored envelope, and nothing else.
   *
   * The counterpart of `save()`, from the branch at js/game_manager.js
   * L85-L89. Removing a key that was never written succeeds, matching
   * src/storage/local-storage-manager.ts.
   *
   * @returns `true` when the removal reached the store.
   */
  clear(): boolean {
    try {
      if (!this.storage.removeRaw(RUN_STATE_KEY)) {
        this.reportRemovalFailure(REMOVE_REFUSED);

        return false;
      }

      return true;
    } catch (error) {
      this.reportRemovalFailure(error);

      return false;
    }
  }

  /**
   * Reports whether a non-empty value is stored under `RUN_STATE_KEY`.
   *
   * Reads the raw string and parses nothing, and never throws. A stored
   * empty string reads as absent, matching the port's `readJson`.
   *
   * @returns `true` when a value is stored.
   */
  exists(): boolean {
    try {
      const raw = this.storage.readRaw(RUN_STATE_KEY);

      return raw !== null && raw.length > 0;
    } catch (error) {
      const report: MutableCorruptionReport = {
        key: RUN_STATE_KEY,
        verdict: 'malformed',
        problems: [PRESENCE_CHECK_FAILED],
        error,
      };

      this.emit(() => {
        this.reporter.onLoadCorrupted?.(report);
      });

      return false;
    }
  }

  /**
   * Resolves a payload that was read: classify, migrate, reconcile the
   * board size, validate, then copy.
   *
   * The reconciliation runs between the migration and the validation, so
   * a stored matrix whose dimensions disagree with its recorded size is
   * repaired rather than refused, and the snapshot handed to
   * `Engine.setup()` already measures the size it records.
   *
   * @param observed Payload the port returned.
   * @param options Identity a wrap adopts, and the sizes to reconcile
   *   against.
   * @returns The resolved envelope, or the outcome that refused it.
   */
  private resolve(
    observed: unknown,
    options: RunStateLoadOptions
  ): RunStateLoadResult {
    const verdict = classify(observed);
    const candidate = toRunStateCandidate(
      observed,
      verdict,
      identityFrom(options)
    );

    if (candidate === null) {
      return this.refuse(verdict, observed, undefined, options, undefined);
    }

    const board = candidate.board;
    const savedGrid = readMemberOf(board, 'grid');

    if (!isRecord(board) || !isRecord(savedGrid)) {
      // A payload carrying no grid object is refused rather than resumed
      // on an invented lattice.
      return this.refuse(verdict, candidate, undefined, options, undefined);
    }

    const reconciled = reconcileBoardSize({
      savedGrid,
      configuredSize: options.boardSize ?? this.config?.boardSize,
      relicBoardSize: options.relicBoardSize,
    });
    const { reconciliation } = reconciled;

    const envelope: RunStateCandidate = {
      ...candidate,
      board: { ...board, grid: reconciled.grid },
    };

    if (!isRunStateShape(envelope)) {
      return this.refuse(
        verdict,
        envelope,
        reconciliation,
        options,
        undefined
      );
    }

    const state = cloneRunState(envelope);
    const correlationId = runCorrelationId(state.seed, state.runId);
    const migrated = verdict === 'absent' || verdict === 'older';

    if (migrated) {
      this.reportMigration(correlationId, readStoredVersion(observed));
    }

    if (reconciliation.action !== 'none') {
      this.reportReconciliation(correlationId, reconciliation);
    }

    let outcome: RunStateLoadOutcome = 'loaded';

    if (reconciliation.action !== 'none') {
      outcome = 'reconciled';
    } else if (migrated) {
      outcome = 'migrated';
    }

    return { state, verdict, outcome, reconciliation };
  }

  /**
   * Reports a refused payload and falls back to a fresh run.
   *
   * Both halves are mandatory: js/local_storage_manager.js L37 caught its
   * error and discarded it, and the caught value, the verdict and the
   * diagnosis all reach the injected sink here instead. No seed and no run
   * identifier is originated; `state` is `null` and the caller starts the
   * fresh run.
   *
   * @param verdict Verdict on the value that was stored.
   * @param refused Value that failed, which is the payload itself or the
   *   candidate assembled from it, whichever got furthest.
   * @param reconciliation Reconciliation record when one had already run.
   * @param options Load options, read for a fallback correlation
   *   identifier.
   * @param thrown The caught value, boxed, or `undefined` when nothing
   *   threw.
   * @returns The `'fresh-fallback'` result.
   */
  private refuse(
    verdict: RunStateVersionVerdict,
    refused: unknown,
    reconciliation: BoardSizeReconciliation | undefined,
    options: RunStateLoadOptions,
    thrown: CaughtError | undefined
  ): RunStateLoadResult {
    const problems = diagnose(refused);
    const report: MutableCorruptionReport = {
      correlationId: resolveCorrelationId(refused, options),
      key: RUN_STATE_KEY,
      verdict,
      problems,
    };

    if (thrown !== undefined) {
      report.error = thrown.caught;
    }

    this.emit(() => {
      this.reporter.onLoadCorrupted?.(report);
    });

    return {
      state: null,
      verdict,
      outcome: 'fresh-fallback',
      reconciliation,
      problems,
    };
  }

  /**
   * Reports a payload read at one schema version and returned at
   * another.
   *
   * @param correlationId Correlation identifier of the migrated run.
   * @param fromVersion Version the payload carried, absent when it
   *   carried none.
   */
  private reportMigration(
    correlationId: string,
    fromVersion: number | undefined
  ): void {
    const report: RunStateMigrationReport = {
      correlationId,
      fromVersion,
      toVersion: RUN_STATE_SCHEMA_VERSION,
    };

    this.emit(() => {
      this.reporter.onVersionMigrated?.(report);
    });
  }

  /**
   * Reports a board size that was reconciled before the grid was rebuilt,
   * with all three sizes and the dropped count, whether or not any tile
   * was lost.
   *
   * @param correlationId Correlation identifier of the run.
   * @param reconciliation What the reconciliation weighed and did.
   */
  private reportReconciliation(
    correlationId: string,
    reconciliation: BoardSizeReconciliation
  ): void {
    const report: BoardSizeReconciliationDetail = {
      correlationId,
      savedSize: reconciliation.savedSize,
      configuredSize: reconciliation.configuredSize,
      appliedSize: reconciliation.appliedSize,
      action: reconciliation.action,
      tilesDropped: reconciliation.tilesDropped,
    };

    this.emit(() => {
      this.reporter.onBoardSizeReconciled?.(report);
    });
  }

  /**
   * Reports a write that did not reach the store, measuring the payload
   * it attempted.
   *
   * @param state Envelope the write carried, typed `unknown` and read
   *   through the total readers: this also reports an envelope that
   *   failed validation.
   * @param error The caught value, or the constant naming the refusal.
   */
  private reportWriteFailure(state: unknown, error: unknown): void {
    const report: RunStateWriteFailureReport = {
      correlationId: correlationIdOf(state),
      key: RUN_STATE_KEY,
      byteLength: measureJsonBytes(state),
      error,
    };

    this.emit(() => {
      this.reporter.onWriteFailed?.(report);
    });
  }

  /**
   * Reports a removal that did not reach the store. No envelope is read,
   * so no run is identified and nothing was serialised.
   *
   * @param error The caught value, or the constant naming the refusal.
   */
  private reportRemovalFailure(error: unknown): void {
    const report: RunStateWriteFailureReport = {
      correlationId: UNIDENTIFIED_CORRELATION_ID,
      key: RUN_STATE_KEY,
      byteLength: 0,
      error,
    };

    this.emit(() => {
      this.reporter.onWriteFailed?.(report);
    });
  }

  /**
   * Delivers one report, containing a sink that refuses it.
   *
   * @param deliver Invokes the sink member, keeping its `this` binding.
   */
  private emit(deliver: () => void): void {
    try {
      deliver();
    } catch {
      // A sink that throws is contained here, so the no-throw guarantee
      // of `load()`, `save()`, `clear()` and `exists()` holds whatever
      // the injected reporter does. There is no second sink the refusal
      // could be reported to.
      return;
    }
  }
}
