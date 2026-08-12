/**
 * Persistence for the versioned run-state envelope: the guarded loader,
 * version migration, board-size reconciliation and robust writes.
 *
 * Every read and every write goes through the injected persistence port, so
 * this module names no Web Storage global and runs unchanged under Node. It
 * reads no DOM, holds no clock and consumes no randomness, and it neither
 * originates a seed nor a run identifier: both arrive as arguments.
 *
 * One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
 * this module's area enumerated:
 *   TR-RUNSTORE-01  js/local_storage_manager.js L52-L55  the unguarded
 *                   `JSON.parse` of the stored snapshot at L54, replaced by
 *                   `load()`, which returns a result for every input
 *   TR-RUNSTORE-02  js/local_storage_manager.js L57-L59  the handler-free
 *                   `setItem`, replaced by `save()`, which returns `false` on
 *                   a failed write including an exhausted quota
 *   TR-RUNSTORE-03  js/local_storage_manager.js L33-L39  the `catch` that
 *                   discarded its caught value; every caught value here
 *                   reaches the injected `RunReporter`
 *   TR-RUNSTORE-04  js/game_manager.js L36-L45           the lattice rebuilt
 *                   from the size the snapshot recorded, replaced by
 *                   `reconcileBoardSize()`, which runs before any grid is
 *                   constructed
 *   TR-RUNSTORE-05  js/game_manager.js L88-L89           the over-or-write
 *                   branch, split into `clear()` and `save()`
 *   TR-RUNSTORE-06  target-only row                      `RunStatePersistencePort`,
 *                   `NULL_PERSISTENCE_PORT` and `migrateRunState()`
 *
 * Decisions: DL-RUNSTORE-01, DL-RUNSTORE-02, DL-RUNSTORE-03, DL-RUNSTORE-04,
 * DL-RUNSTORE-05, DL-RUN-03 (docs/DECISION_LOG.md).
 */

import { isSupportedBoardSize } from '../config/default-config';
import type { RulesConfig } from '../config/rules-config';
import type {
  CellMatrix,
  CorrelationId,
  CorrelationSource,
  SerializedGrid,
  SerializedTile,
} from '../engine/types';
import { correlationReader } from '../engine/types';
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
  MAX_SUPPORTED_BOARD_SIZE,
  normalizeRngCursor,
  NOOP_RUN_REPORTER,
  projectCurrentRunState,
  resolveRunStateVersionPolicy,
  type BoardSizeReconciliationReport,
  type PersistedRelic,
  type RunReporter,
  type RunState,
  type RunStateCorruptionReport,
  type RunStateMigrationReport,
  type RunStateVersionPolicy,
  type RunStateVersionVerdict,
  type RunStateWriteFailureReport,
} from './run-state';

/**
 * Edge length applied when neither the active relics, the rules configuration
 * nor the stored snapshot supplies a usable one.
 */
const FALLBACK_BOARD_SIZE = 1;

/** The empty result `peekRelics` returns for every envelope it cannot read. */
const NO_PERSISTED_RELICS: readonly PersistedRelic[] = Object.freeze([]);

/**
 * Bytes per UTF-16 code unit, the measure
 * `RunStateWriteFailureReport.byteLength` carries.
 */
const BYTES_PER_UTF16_UNIT = 2;

const WRITE_REFUSED = 'the persistence port reported a failed write';

const REMOVE_REFUSED = 'the persistence port reported a failed removal';

const ENVELOPE_REFUSED =
  'the envelope was not a structurally complete run state';

const PRESENCE_CHECK_FAILED = 'the presence check on the run state threw';

const DIAGNOSIS_REFUSED = 'the stored run state could not be diagnosed';

/**
 * The stage clear condition an envelope carries, taken from `RunState` so this
 * module names the stage configuration only through the envelope that already
 * declares it.
 */
export type PersistedStageGoal = RunState['stageGoal'];

/**
 * A caught value, boxed so a thrown `undefined` stays distinguishable from no
 * throw at all.
 */
interface CaughtError {
  readonly caught: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads one member of a plain object without throwing. */
function readSafely(source: Record<string, unknown>, name: string): unknown {
  try {
    return source[name];
  } catch {
    return undefined;
  }
}

function readMemberOf(source: unknown, name: string): unknown {
  return isRecord(source) ? readSafely(source, name) : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reports whether `value` is a usable board edge length: a positive safe
 * integer at or below `MAX_BOARD_SIZE`, matching `isBoardSize` in
 * src/run/run-state.ts.
 *
 * @param value Value to test.
 * @returns `true` for a supported board edge length.
 */
function isBoardEdgeLength(value: unknown): value is number {
  return isSupportedBoardSize(value);


}

function diagnose(value: unknown): string[] {
  try {
    return describeRunStateProblems(value);
  } catch {
    return [DIAGNOSIS_REFUSED];
  }
}

function classify(
  value: unknown,
  policy?: RunStateVersionPolicy
): RunStateVersionVerdict {
  try {
    return classifyRunStateVersion(value, policy);
  } catch {
    return 'malformed';
  }
}

function measureJsonBytes(value: unknown): number {
  try {
    const json: string | undefined = JSON.stringify(value);

    return json === undefined ? 0 : json.length * BYTES_PER_UTF16_UNIT;
  } catch {
    return 0;
  }
}

/**
 * The four members of src/storage/local-storage-manager.ts this module calls,
 * as a structural port. `LocalStorageManager` satisfies it structurally, so a
 * unit test drives the store with a four-method object and no mocking library.
 *
 * `readRaw` powers `exists` and separates an absent key from a stored value
 * that is not valid JSON, which `readJson` alone reports identically as
 * `null`. `readJson` supplies the guarded parse. `writeJson` and `removeRaw`
 * report failure by return value.
 */
export interface RunStatePersistencePort {
  readRaw(key: OwnedStorageKey): string | null;
  readJson(key: OwnedStorageKey): unknown;
  writeJson(key: OwnedStorageKey, value: unknown): boolean;
  removeRaw(key: OwnedStorageKey): boolean;
}

type Assert<T extends true> = T;

/**
 * Compile-time check that src/storage/local-storage-manager.ts satisfies
 * `RunStatePersistencePort`. A signature drift on either side makes this alias
 * `Assert<false>`, which does not compile.
 */
export type LocalStorageManagerSatisfiesPort = Assert<
  LocalStorageManager extends RunStatePersistencePort ? true : false
>;

/**
 * A fully implemented port that stores nothing, for a store constructed
 * without one. A read reports an absent key, a write reports failure, and a
 * removal succeeds — the semantics src/storage/local-storage-manager.ts gives
 * a removal of a key that was never written.
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
 * The bounded, single-parse envelope read
 * ----------------------------------------------------------------------- */

/**
 * Largest stored run-state text, in bytes, that may be parsed.
 *
 * Measured at two bytes per UTF-16 code unit, the way Web Storage charges for a
 * value. A fresh two-tile envelope serialises to a few hundred bytes and a full
 * board with a full relic set to a couple of thousand, so this is generous by
 * two orders of magnitude while still bounding what the startup path will parse.
 *
 * THIS MODULE OWNS THE SCHEMA, so this module owns the schema's size bound. The
 * storage adapter declares a ceiling of its own for the same key; both apply and
 * the tighter one governs, which is the defence the envelope needs against a
 * bare port that has no adapter behind it. Decision DL-RUNSTORE-06.
 */
export const MAX_RUN_STATE_PAYLOAD_BYTES = 131_072;

/** The stored envelope, read once and parsed at most once. */
export interface RunStateSnapshot {
  /** Whether a non-empty value is stored. */
  readonly present: boolean;

  /** Size of the stored text in bytes, and `0` when nothing is stored. */
  readonly bytes: number;

  /** Whether the text broke `MAX_RUN_STATE_PAYLOAD_BYTES` and was not parsed. */
  readonly oversize: boolean;

  /**
   * The parsed value. `null` when nothing is stored, when the text was refused
   * for size, and when the port's own guarded parse could not read it.
   */
  readonly parsed: unknown;
}

/** The empty snapshot yielded for an absent or empty stored value. */
const ABSENT_SNAPSHOT: RunStateSnapshot = Object.freeze({
  present: false,
  bytes: 0,
  oversize: false,
  parsed: null,
});

/**
 * The port members `readRunStateSnapshot()` needs. `readRaw` is optional so the
 * identity resolution of src/run/run-controller.ts, which is handed a port
 * narrowed to `readJson` alone, can share this one reader.
 */
export type RunStateSnapshotPort = Pick<RunStatePersistencePort, 'readJson'> &
  Partial<Pick<RunStatePersistencePort, 'readRaw'>>;

/**
 * Reads the stored envelope, bounding the text before anything parses it.
 *
 * THE ONE READ every startup consumer shares. Three of them exist — the run
 * identity, the relic pre-read that breaks the board-size cycle, and the
 * authoritative load — and each used to read and parse the value for itself, so
 * one untrusted blob was parsed three times on the startup path before any
 * schema, version or array bound applied to it. Routing all three through here
 * means the size gate is applied once per read and, behind the real storage
 * adapter, which memoises a parse per key on the exact stored text, the blob is
 * parsed exactly once per boot. Decision DL-RUNSTORE-06.
 *
 * DOES NOT CATCH. A port that raises must reach its caller's own handler, which
 * is what carries the caught value to the corruption channel — the
 * pre-migration read discarded it and every caller here reports it instead.
 *
 * @param storage Port to read through.
 * @returns What is stored, measured, and parsed unless it was refused.
 * @throws Whatever the port's `readRaw` or `readJson` raises.
 */
export function readRunStateSnapshot(
  storage: RunStateSnapshotPort
): RunStateSnapshot {
  const readRaw = storage.readRaw;

  if (readRaw === undefined) {
    // A port narrowed to `readJson` cannot be measured, so the adapter's own
    // per-key ceiling is the whole bound for it. `readJson` of
    // src/storage/local-storage-manager.ts applies that before it parses.
    const parsed: unknown = storage.readJson(RUN_STATE_KEY);

    return Object.freeze({
      present: parsed !== null && parsed !== undefined,
      bytes: 0,
      oversize: false,
      parsed: parsed ?? null,
    });
  }

  const raw = readRaw.call(storage, RUN_STATE_KEY);

  if (raw === null || raw.length === 0) {
    return ABSENT_SNAPSHOT;
  }

  const bytes = raw.length * BYTES_PER_UTF16_UNIT;

  if (bytes > MAX_RUN_STATE_PAYLOAD_BYTES) {
    return Object.freeze({
      present: true,
      bytes,
      oversize: true,
      parsed: null,
    });
  }

  return Object.freeze({
    present: true,
    bytes,
    oversize: false,
    parsed: storage.readJson(RUN_STATE_KEY),
  });
}

export type BoardSizeReconciliationAction =
  | 'none'
  | 'grew'
  | 'shrank'
  /**
   * The applied size equals the recorded size, and the stored matrix still had
   * to be rebuilt: it did not measure that size, held a cell that was neither
   * a tile nor `null`, held a hole where js/grid.js L109 wrote `null`, or held
   * a tile whose recorded position disagreed with the cell it occupied.
   */
  | 'repaired';

export interface BoardSizeReconciliation {
  /**
   * Edge length the snapshot recorded in `board.grid.size`, falling back to
   * the outer length of the stored matrix when that member is not a supported
   * board edge length, and `0` when neither is usable — which includes a
   * recorded size or a matrix above `MAX_BOARD_SIZE`.
   */
  readonly savedSize: number;

  /**
   * Edge length the live rules configuration declares, and `0` when no
   * configuration was supplied or the one supplied is not a supported board
   * edge length.
   */
  readonly configuredSize: number;

  /**
   * Edge length the active board-mutating relics imply, and `0` when the
   * caller supplied none or the one supplied is not a supported board edge
   * length. Takes precedence over `configuredSize`.
   */
  readonly relicSize: number;
  readonly appliedSize: number;
  readonly action: BoardSizeReconciliationAction;

  /**
   * Whether this reconciliation resolved a real precedence decision, which is
   * what `RunStateStore.load` reports on.
   */
  readonly reportable: boolean;

  /**
   * Count of tiles that lay outside the applied bounds and were dropped. A
   * cell that was not a tile at all is not counted here; it sets `action` to
   * `'repaired'`.
   */
  readonly tilesDropped: number;
}

/**
 * A `BoardSizeReconciliation` addressed to a `RunReporter`.
 *
 * Extends `BoardSizeReconciliationReport`, so it is accepted by
 * `RunReporter.onBoardSizeReconciled` while also carrying the action and the
 * dropped count.
 */
export interface BoardSizeReconciliationDetail
  extends BoardSizeReconciliationReport,
    BoardSizeReconciliation {}

export interface BoardSizeReconciliationInput {
  /**
   * `board.grid` exactly as it came out of storage. Untrusted: any value is
   * accepted, and one that is not `{ size, cells }` yields an empty lattice at
   * the applied size.
   */
  readonly savedGrid: unknown;

  /**
   * `RulesConfig.boardSize` of the live configuration. Ignored when it is not
   * a supported board edge length.
   */
  readonly configuredSize?: number;

  /**
   * Edge length the active board-mutating relics imply, which takes precedence
   * over `configuredSize`. Ignored when it is not a positive safe integer.
   */
  readonly relicBoardSize?: number;
}

export interface BoardSizeReconciliationResult {
  /**
   * The reconciled grid. `size` equals `reconciliation.appliedSize`, `cells`
   * measures exactly that size on both axes, every empty cell is `null`, and
   * every retained tile's `position` is the cell it occupies.
   */
  readonly grid: SerializedGrid;
  readonly reconciliation: BoardSizeReconciliation;
}

interface ReadTile {
  readonly value: number;
  readonly recordedX: number;
  readonly recordedY: number;
}

/**
 * Reads one stored cell as a tile.
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
 * The edge length the held relics declare, taken as the SMALLEST declaration.
 *
 * @param relics The envelope's relic entries.
 * @returns The smallest declared edge length, or `undefined` where none is
 *   declared.
 */
function declaredRelicBoardSize(relics: unknown): number | undefined {
  if (!Array.isArray(relics)) {
    return undefined;
  }

  let smallest: number | undefined;

  for (const entry of relics) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }

    const state: unknown = (entry as { state?: unknown }).state;

    if (state === null || typeof state !== 'object') {
      continue;
    }

    const declared: unknown = (state as { boardSize?: unknown }).boardSize;

    if (!isBoardEdgeLength(declared)) {
      continue;
    }

    if (smallest === undefined || declared < smallest) {
      smallest = declared;
    }
  }

  return smallest;
}

/**
 * Reconciles the size a snapshot recorded, the size the rules configuration
 * declares and the size the active board-mutating relics imply, and rebuilds
 * the cell matrix at the result.
 *
 * @param input The stored grid and the two candidate sizes.
 * @returns The reconciled grid and the record of what was done.
 */
export function reconcileBoardSize(
  input: BoardSizeReconciliationInput
): BoardSizeReconciliationResult {
  const rawSize = readMemberOf(input.savedGrid, 'size');
  const rawCells = readMemberOf(input.savedGrid, 'cells');

  // `Array.isArray` widens an unknown to `any[]`; the annotation narrows every
  // later element read back to `unknown`.
  const storedColumns: readonly unknown[] | null = Array.isArray(rawCells)
    ? rawCells
    : null;

  // A matrix whose outer length is not a supported board edge is not walked at
  // all: the walk below is linear in that length, and the edge it would imply
  // is refused by `isBoardEdgeLength` in any case.
  const columns: readonly unknown[] | null =
    storedColumns !== null && isBoardEdgeLength(storedColumns.length)
      ? storedColumns
      : null;

  const matrixSize = columns === null ? 0 : columns.length;
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

  // Set when the stored matrix did not already measure `savedSize` with a tile
  // or `null` in every cell and every tile in the cell it recorded.
  let repaired = false;

  if (columns === null) {
    // A grid carrying no matrix at all is not an inconsistency to repair
    // unless it carried something in that member's place — which covers a
    // matrix that was present but measured an unsupported edge.
    repaired = rawCells !== undefined;
  } else {
    if (columns.length !== savedSize) {
      repaired = true;
    }

    // The walk is bounded by the supported edge length, not by the length the
    // stored array declares.
    const columnLimit = Math.min(columns.length, MAX_SUPPORTED_BOARD_SIZE);

    for (let x = 0; x < columnLimit; x += 1) {
      const sourceColumn: unknown = columns[x];

      if (!Array.isArray(sourceColumn)) {
        repaired = true;
        continue;
      }

      const column: readonly unknown[] = sourceColumn;

      if (column.length !== savedSize) {
        repaired = true;
      }

      const cellLimit = Math.min(column.length, MAX_SUPPORTED_BOARD_SIZE);

      for (let y = 0; y < cellLimit; y += 1) {
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

  // A size the caller supplied and this function refused is a decision taken,
  // even though the refused value is recorded as 0.
  const refusedInput =
    (input.configuredSize !== undefined && configuredSize === 0) ||
    (input.relicBoardSize !== undefined && relicSize === 0);

  // A usable candidate that is not the size applied is a precedence decision,
  // whether or not the applied size changed the lattice.
  const disagreed = [savedSize, configuredSize, relicSize].some(
    (candidate) => candidate > 0 && candidate !== appliedSize
  );

  return {
    // Member order matches js/grid.js L113-L116.
    grid: { size: appliedSize, cells },
    reconciliation: {
      savedSize,
      configuredSize,
      relicSize,
      appliedSize,
      action,
      tilesDropped,
      reportable:
        action !== 'none' || disagreed || relicSize > 0 || refusedInput,
    },
  };
}

/**
 * The identity a migrated envelope adopts when the stored payload carries none
 * of its own.
 *
 * Nothing in this module mints either: both arrive as arguments.
 */
export interface RunStateMigrationIdentity {
  readonly runId: string;
  readonly seed: string;
  readonly stageGoal: PersistedStageGoal;
}

/** An envelope assembled from a stored payload but not yet validated. */
type RunStateCandidate = Record<string, unknown>;

const BOARD_MEMBERS = ['grid', 'score', 'over', 'won', 'keepPlaying'] as const;

/**
 * Copies the five members of a board snapshot, in the order the pre-migration
 * game wrote them, so a payload round-trips through this module byte for byte.
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
 * Assembles a candidate from a stored envelope, stamping the current schema
 * version.
 *
 * @param value Stored payload.
 * @param targetVersion Version the candidate is stamped at, which is the
 *   resolved policy's `current`.
 */
function envelopeCandidate(
  value: unknown,
  targetVersion: number
): RunStateCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  // The one OPTIONAL member: carried through only where the payload holds it,
  // so an envelope without an unresolved reward round assembles exactly the nine
  // members it did before. Carried by value and left to validation, as every
  // other member is — a malformed round is refused by `isRunStateShape()` and
  // reported through the corruption path rather than being quietly dropped
  // here, where there is no reporter to say so. DL-RUN-06.
  const pending = readSafely(value, 'pendingReward');

  return {
    schemaVersion: targetVersion,
    runId: readSafely(value, 'runId'),
    seed: readSafely(value, 'seed'),
    rngCursor: normalizeRngCursor(readSafely(value, 'rngCursor')),
    stageIndex: readSafely(value, 'stageIndex'),
    stageGoal: readSafely(value, 'stageGoal'),
    goalProgress: readSafely(value, 'goalProgress'),
    relics: readSafely(value, 'relics'),
    board: boardCandidate(readSafely(value, 'board')),
    ...(pending === undefined ? {} : { pendingReward: pending }),
  };
}

function readStoredVersion(value: unknown): number | undefined {
  const stored = readMemberOf(value, 'schemaVersion');

  return typeof stored === 'number' && Number.isInteger(stored)
    ? stored
    : undefined;
}

/**
 * Assembles a candidate from an envelope stored at an earlier schema version.
 *
 * @param value Stored payload.
 * @param policy Resolved version policy whose history admits the stored
 *   version and whose `current` the candidate is re-stamped to.
 */
function olderEnvelopeCandidate(
  value: unknown,
  policy: RunStateVersionPolicy
): RunStateCandidate | null {
  const version = readStoredVersion(value);

  if (version === undefined || !policy.history.includes(version)) {
    return null;
  }

  return envelopeCandidate(value, policy.current);
}

/**
 * Assembles a candidate from a payload carrying no `schemaVersion` member at
 * all.
 *
 * @param value Stored payload.
 * @param identity Seed, run identifier and stage goal a wrap adopts.
 * @param targetVersion Version the candidate is stamped at, which is the
 *   resolved policy's `current`.
 */
function unversionedCandidate(
  value: unknown,
  identity: RunStateMigrationIdentity | undefined,
  targetVersion: number
): RunStateCandidate | null {
  if (!isRecord(value)) {
    return null;
  }

  if (isRecord(readSafely(value, 'board'))) {
    return envelopeCandidate(value, targetVersion);
  }

  if (identity === undefined || !isRecord(readSafely(value, 'grid'))) {
    return null;
  }

  return {
    schemaVersion: targetVersion,
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
 * Assembles a candidate for one verdict. The chain is keyed on the verdict, so
 * a schema version added to a policy's history is absorbed by
 * `olderEnvelopeCandidate` without a change here or in `load`.
 *
 * @param value Stored payload.
 * @param verdict Classification of that payload.
 * @param identity Seed, run identifier and stage goal a wrap adopts.
 * @param policy Resolved version policy.
 */
function toRunStateCandidate(
  value: unknown,
  verdict: RunStateVersionVerdict,
  identity: RunStateMigrationIdentity | undefined,
  policy: RunStateVersionPolicy
): RunStateCandidate | null {
  switch (verdict) {
    case 'current':
      return envelopeCandidate(value, policy.current);
    case 'older':
      return olderEnvelopeCandidate(value, policy);
    case 'absent':
      return unversionedCandidate(value, identity, policy.current);
    case 'unknown':
    // A payload from a newer build is not salvaged: its members are not this
    // build's members, and a partial read would half-load a run.
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
 * Pure: no storage, no reporter, no clock, no randomness, and neither argument
 * is mutated. Neither a seed nor a run identifier is originated; a payload
 * that needs one and is given no `identity` is refused.
 *
 * @param value Stored payload.
 * @param verdict Classification of that payload, normally from
 *   `classifyRunStateVersion(value, policy)` under the same policy.
 * @param identity Seed, run identifier and stage goal a wrap adopts.
 * @param policy Version set the migration re-stamps against, resolved
 *   through `resolveRunStateVersionPolicy`. Defaults to
 *   `RUN_STATE_VERSION_POLICY`, under which the target version is
 *   `RUN_STATE_SCHEMA_VERSION`.
 */
export function migrateRunState(
  value: unknown,
  verdict: RunStateVersionVerdict,
  identity?: RunStateMigrationIdentity,
  policy?: RunStateVersionPolicy
): RunState | null {
  const resolved = resolveRunStateVersionPolicy(policy);
  const candidate = toRunStateCandidate(value, verdict, identity, resolved);

  if (candidate === null || !isRunStateShape(candidate)) {
    return null;
  }

  return cloneRunState(candidate);
}

export type RunStateLoadOutcome =
  | 'loaded'
  | 'migrated'
  /**
   * A stored payload was returned after a board-size precedence decision
   * resolved, whether or not it was also migrated. Takes precedence over
   * `'migrated'` and `'loaded'`.
   */
  | 'reconciled'
  /**
   * The stored payload was refused. `state` is `null` and `problems` carries
   * the diagnosis; the caller starts a fresh run, which is where a seed and a
   * run identifier are originated.
   */
  | 'fresh-fallback'
  | 'absent';

export interface RunStateLoadResult {
  /**
   * The resolved envelope, or `null` on `'absent'` and `'fresh-fallback'`.
   * Deep-copied, so the caller holds nothing the store or the stored payload
   * also holds.
   */
  readonly state: RunState | null;

  /**
   * `classifyRunStateVersion`'s verdict on the value that was stored, not on
   * whatever intermediate value a refusal diagnosed.
   */
  readonly verdict: RunStateVersionVerdict;
  readonly outcome: RunStateLoadOutcome;

  /**
   * The record of the board-size reconciliation, present whenever one ran —
   * including when it changed nothing, where `action` is `'none'`. Absent on
   * `'absent'`, and on a refusal that happened before the reconciliation could
   * run.
   */
  readonly reconciliation?: BoardSizeReconciliation;

  /**
   * `describeRunStateProblems`'s diagnosis of the refused value, present on
   * `'fresh-fallback'` alone.
   */
  readonly problems?: readonly string[];
}

export interface RunStateLoadOptions {
  /**
   * Run identifier a wrap of an unversioned board snapshot adopts. A wrap is
   * refused when this, `seed` or `stageGoal` is missing.
   */
  readonly runId?: string;
  readonly seed?: string;
  readonly stageGoal?: PersistedStageGoal;

  /**
   * Edge length to reconcile against, overriding the injected configuration's
   * `boardSize` for this load.
   */
  readonly boardSize?: number;
  readonly relicBoardSize?: number;
}

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

type MutableCorruptionReport = {
  -readonly [K in keyof RunStateCorruptionReport]: RunStateCorruptionReport[K];
};

export interface RunStateStoreOptions {
  /**
   * Where the envelope is persisted. Defaults to `NULL_PERSISTENCE_PORT`, so a
   * store is constructible with no arguments and holds nothing until one is
   * supplied.
   */
  readonly storage?: RunStatePersistencePort;

  /**
   * Where refusals, migrations, reconciliations and failed writes are
   * reported. Defaults to `NOOP_RUN_REPORTER`.
   */
  readonly reporter?: RunReporter;

  /**
   * The live rules configuration, read for `boardSize` alone and read at each
   * load rather than copied, so a board-mutating relic that reconciles
   * `boardSize` for a run is seen on the next load.
   */
  readonly config?: RulesConfig;

  /**
   * Correlation identifier every report from this store carries. Injected,
   * never derived here: the one authority is `deriveCorrelationId` in
   * src/observability/logger.ts, and no seed — neither the caller's nor a
   * stored payload's — is read for it.
   */
  readonly correlationId?: CorrelationSource;

  /**
   * The version set every load classifies and re-stamps against. Defaults to
   * `RUN_STATE_VERSION_POLICY`, this build's own current version and history,
   * so a store constructed with no arguments behaves exactly as it did before
   * the option existed.
   */
  readonly versionPolicy?: RunStateVersionPolicy;
}

/** Reads and writes the versioned run-state envelope under `RUN_STATE_KEY`. */
export class RunStateStore {
  private readonly storage: RunStatePersistencePort;

  private readonly reporter: RunReporter;

  private readonly config: RulesConfig | undefined;

  /** Reads the correlation identifier every report carries. */
  private readonly readCorrelationId: () => CorrelationId;

  /**
   * Version set every load classifies and re-stamps against, resolved once at
   * construction so no later read can be handed a hostile policy.
   */
  private readonly versionPolicy: RunStateVersionPolicy;

  /**
   * @param options Port, reporter, configuration, correlation identifier and
   *   version policy, each optional.
   */
  constructor(options: RunStateStoreOptions = {}) {
    this.storage = options.storage ?? NULL_PERSISTENCE_PORT;
    this.reporter = options.reporter ?? NOOP_RUN_REPORTER;
    this.config = options.config;
    this.readCorrelationId = correlationReader(options.correlationId);
    this.versionPolicy = resolveRunStateVersionPolicy(options.versionPolicy);
  }

  /**
   * Reads the stored envelope, migrating and reconciling it as needed.
   *
   * The read is wrapped here as well as in the port's own guarded parse: a
   * member read that an accessor refuses during validation or copying is
   * caught at this level.
   */
  load(options: RunStateLoadOptions = {}): RunStateLoadResult {
    let observed: unknown;

    try {
      // One bounded read, shared with `peekRelics()` and with the identity
      // resolution of src/run/run-controller.ts. DL-RUNSTORE-06.
      const snapshot = readRunStateSnapshot(this.storage);

      if (!snapshot.present) {
        return { state: null, verdict: 'absent', outcome: 'absent' };
      }

      if (snapshot.oversize) {
        return this.refuseOversize(snapshot.bytes);
      }

      observed = snapshot.parsed;

      return this.resolve(observed, options);
    } catch (error) {
      return this.refuse(
        classify(observed, this.versionPolicy),
        observed,
        undefined,
        { caught: error }
      );
    }
  }

  /**
   * Reads the persisted relic entries out of the stored envelope WITHOUT
   * reconciling anything.
   *
   * @returns A fresh array of the stored entries, in the order they were
   *   stored, which is pickup order.
   */
  peekRelics(): readonly PersistedRelic[] {
    try {
      // The same bounded read `load()` performs, so the peek adds no parse of
      // its own and cannot read a payload the load would have refused.
      // DL-RUNSTORE-06.
      const snapshot = readRunStateSnapshot(this.storage);

      if (!snapshot.present || snapshot.oversize) {
        return NO_PERSISTED_RELICS;
      }

      const observed: unknown = snapshot.parsed;

      if (typeof observed !== 'object' || observed === null) {
        return NO_PERSISTED_RELICS;
      }

      const held: unknown = (observed as { relics?: unknown }).relics;

      if (!Array.isArray(held)) {
        return NO_PERSISTED_RELICS;
      }

      const entries: PersistedRelic[] = [];

      for (const entry of held as readonly unknown[]) {
        if (typeof entry !== 'object' || entry === null) {
          continue;
        }

        const id: unknown = (entry as { id?: unknown }).id;

        if (typeof id !== 'string' || id.length === 0) {
          continue;
        }

        entries.push(entry as PersistedRelic);
      }

      return entries;
    } catch {
      return NO_PERSISTED_RELICS;
    }
  }

  /**
   * Writes `state` under `RUN_STATE_KEY`.
   *
   * The pre-migration writes called `setItem` with no handler, so an exhausted
   * quota left the commit path as an exception. A refused or failed write is
   * reported through the injected `RunReporter` and returned as `false`.
   *
   * A malformed envelope is refused before the port is touched, so a value
   * that could not be read back is never stored.
   */
  save(state: RunState): boolean {
    try {
      if (!this.isWritable(state)) {
        this.reportWriteFailure(state, ENVELOPE_REFUSED);

        return false;
      }

      const payload = projectCurrentRunState(
        state,
        this.versionPolicy.current
      );

      if (!this.storage.writeJson(RUN_STATE_KEY, payload)) {
        this.reportWriteFailure(payload, WRITE_REFUSED);

        return false;
      }

      return true;
    } catch (error) {
      this.reportWriteFailure(state, error);

      return false;
    }
  }

  /**
   * Removes the stored envelope, and nothing else. The counterpart of `save`.
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
   * Reports whether a non-empty value is stored under `RUN_STATE_KEY`. Reads
   * the raw string and parses nothing, and never throws.
   */
  exists(): boolean {
    try {
      const raw = this.storage.readRaw(RUN_STATE_KEY);

      return raw !== null && raw.length > 0;
    } catch (error) {
      const report: MutableCorruptionReport = {
        correlationId: this.reportedCorrelationId(),
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
   * Resolves a payload that was read: classify, migrate, validate, reconcile
   * the board size, validate again, then copy.
   *
   * The reconciliation therefore only ever weighs sizes and repositions valid
   * tiles, so the `tilesDropped` count it reports is the true count of tiles
   * lost to a shrink. The second validation is a structural last line over the
   * rebuilt envelope.
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
    const verdict = classify(observed, this.versionPolicy);
    const candidate = toRunStateCandidate(
      observed,
      verdict,
      identityFrom(options),
      this.versionPolicy
    );

    if (candidate === null) {
      return this.refuse(verdict, observed, undefined, undefined);
    }

    if (!isRunStateShape(candidate)) {
      // Content is refused before any lattice is built, so a corrupt payload
      // cannot be reported as loaded or reconciled, and the reconciliation
      // that follows only ever weighs sizes and repositions valid tiles.
      return this.refuse(verdict, candidate, undefined, undefined);
    }

    const board = candidate.board;
    const savedGrid = board.grid;

    const reconciled = reconcileBoardSize({
      savedGrid,
      configuredSize: options.boardSize ?? this.config?.boardSize,

      relicBoardSize:
        options.relicBoardSize ?? declaredRelicBoardSize(candidate.relics),
    });
    const { reconciliation } = reconciled;

    const envelope: RunStateCandidate = {
      ...candidate,
      board: { ...board, grid: reconciled.grid },
    };

    if (!isRunStateShape(envelope)) {
      return this.refuse(verdict, envelope, reconciliation, undefined);
    }

    const state = cloneRunState(envelope);
    const migrated = verdict === 'absent' || verdict === 'older';

    if (migrated) {
      this.reportMigration(readStoredVersion(observed));
    }

    // Branched on `reportable`, NOT ON `action`.
    if (reconciliation.reportable) {
      this.reportReconciliation(reconciliation);
    }

    let outcome: RunStateLoadOutcome = 'loaded';

    if (reconciliation.reportable) {
      outcome = 'reconciled';
    } else if (migrated) {
      outcome = 'migrated';
    }

    return { state, verdict, outcome, reconciliation };
  }

  /**
   * Reports a refused payload and falls back to a fresh run.
   *
   * Both halves are mandatory: the pre-migration loader caught its error and
   * discarded it, and the caught value, the verdict and the diagnosis all
   * reach the injected sink here instead. No seed and no run identifier is
   * originated; `state` is `null` and the caller starts the fresh run.
   */
  private refuse(
    verdict: RunStateVersionVerdict,
    refused: unknown,
    reconciliation: BoardSizeReconciliation | undefined,
    thrown: CaughtError | undefined
  ): RunStateLoadResult {
    const problems = diagnose(refused);
    const report: MutableCorruptionReport = {
      correlationId: this.reportedCorrelationId(),
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
   * Reports a stored envelope refused for size, and falls back to a fresh run.
   *
   * Reported on the SAME corruption channel a malformed payload is, because to
   * the caller it is the same outcome — the run falls back to fresh and the
   * fallback is recorded. `'malformed'` is the verdict: the value cannot be
   * classified, since classifying it would mean parsing it, which is the cost
   * being refused. The report carries the two measurements and no excerpt of the
   * value. Decision DL-RUNSTORE-06.
   *
   * @param bytes Size of the stored text.
   * @returns The fresh-fallback result.
   */
  private refuseOversize(bytes: number): RunStateLoadResult {
    const problems: readonly string[] = Object.freeze([
      `stored run state is ${String(bytes)} bytes, above the ` +
        `${String(MAX_RUN_STATE_PAYLOAD_BYTES)}-byte ceiling; it was not parsed`,
    ]);
    const report: MutableCorruptionReport = {
      correlationId: this.reportedCorrelationId(),
      key: RUN_STATE_KEY,
      verdict: 'malformed',
      problems,
    };

    this.emit(() => {
      this.reporter.onLoadCorrupted?.(report);
    });

    return {
      state: null,
      verdict: 'malformed',
      outcome: 'fresh-fallback',
      problems,
    };
  }

  /**
   * Reports a payload read at one schema version and returned at
   * another.
   *
   * @param fromVersion Version the payload carried, absent when it carried
   *   none.
   */
  private reportMigration(fromVersion: number | undefined): void {
    const report: RunStateMigrationReport = {
      correlationId: this.readCorrelationId(),
      fromVersion,
      toVersion: this.versionPolicy.current,
    };

    this.emit(() => {
      this.reporter.onVersionMigrated?.(report);
    });
  }

  /**
   * Reports a board size that was reconciled before the grid was rebuilt, with
   * all three sizes and the dropped count, whether or not any tile was lost.
   *
   * @param reconciliation What the reconciliation weighed and did.
   */
  private reportReconciliation(
    reconciliation: BoardSizeReconciliation
  ): void {
    const report: BoardSizeReconciliationDetail = {
      correlationId: this.readCorrelationId(),
      savedSize: reconciliation.savedSize,
      configuredSize: reconciliation.configuredSize,
      relicSize: reconciliation.relicSize,
      appliedSize: reconciliation.appliedSize,
      action: reconciliation.action,
      tilesDropped: reconciliation.tilesDropped,
      reportable: reconciliation.reportable,
    };

    this.emit(() => {
      this.reporter.onBoardSizeReconciled?.(report);
    });
  }

  private reportWriteFailure(state: unknown, error: unknown): void {
    const report: RunStateWriteFailureReport = {
      correlationId: this.readCorrelationId(),
      key: RUN_STATE_KEY,
      byteLength: measureJsonBytes(state),
      error,
    };

    this.emit(() => {
      this.reporter.onWriteFailed?.(report);
    });
  }

  /**
   * Reports a removal that did not reach the store. Nothing was read and
   * nothing was serialised, so only the injected correlation identifier
   * identifies it.
   *
   * @param error The caught value, or the constant naming the refusal.
   */
  private reportRemovalFailure(error: unknown): void {
    const report: RunStateWriteFailureReport = {
      correlationId: this.readCorrelationId(),
      key: RUN_STATE_KEY,
      byteLength: 0,
      error,
    };

    this.emit(() => {
      this.reporter.onWriteFailed?.(report);
    });
  }

  /**
   * Reports whether `state` is an envelope this store may write: structurally
   * complete, and carrying the version its own next load classifies as
   * `'current'`.
   *
   * @param state Envelope offered for writing.
   * @returns `true` when the envelope may be written.
   */
  private isWritable(state: RunState): boolean {
    return (
      classify(state, this.versionPolicy) === 'current' &&
      isRunStateShape(state)
    );
  }

  /**
   * Reads the injected correlation identifier for a report whose member is
   * optional.
   *
   * @returns The identifier, or `undefined` when the store was constructed
   *   without one and when the injected reader resolves to the empty string.
   */
  private reportedCorrelationId(): CorrelationId | undefined {
    const correlationId = this.readCorrelationId();

    return correlationId.length === 0 ? undefined : correlationId;
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
      // A sink that throws is contained here, so the no-throw guarantee of
      // `load`, `save`, `clear` and `exists` holds whatever the injected
      // reporter does.
      return;
    }
  }
}
