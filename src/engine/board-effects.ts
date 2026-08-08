// The transactional board-effect channel: the commands a hook handler records
// against the board and the rules, and the applier that writes them.
//
// WHAT THIS MODULE IS FOR
//   src/engine/hooks.ts hands a handler `ReadonlyGridView` and
//   `ReadonlyRulesView`, so nothing reachable from a handler can write the
//   lattice or the rules. The relic effects AAP requirement R3 names — an extra
//   spawned tile, an undo, a shuffle, an excision, a row clear, a board shrink,
//   a substituted merge predicate and a substituted spawn distribution — are
//   all writes. This module is the write channel: a handler RECORDS commands
//   and the bus APPLIES them, so the capability arrives without a handler ever
//   holding the live `Grid`, a live `Tile` or the live `RulesConfig`.
//
// THE TRANSACTION
//   src/engine/hook-bus.ts opens one queue per handler, alongside the handler's
//   randomness fork, and resolves the two together: `applyBoardEffects` runs
//   only once the handler has returned and its return has validated, and the
//   queue is dropped unapplied when the handler throws or its return is
//   refused. A handler that records and then throws therefore leaves the board
//   and the rules exactly as it found them.
//
// THE PROJECTION
//   A command is validated as it is recorded, against this queue's own
//   projected board rather than the live one: the live board has not changed
//   yet, so a handler planning several steps — a shuffle placing every tile, a
//   shrink re-homing several exiles — would otherwise be told a cell it has
//   already claimed is still free. The projection is built from
//   `ReadonlyGridView.serialize()` on first use and advanced by each accepted
//   command, and its query members are what a multi-step handler reads.
//
// COMMAND ORDER IS THE RECORD ORDER
//   `applyBoardEffects` replays commands in the order they were recorded and
//   never reorders or coalesces them, so the board the applier produces is the
//   board the projection described.
//
// THE RELOCATION ORDER
//   Every lattice write goes through `Grid.insertTile` / `Grid.removeTile` plus
//   `Tile.updatePosition`, which index by the flattened `tile.x` / `tile.y` of
//   js/grid.js L88-L94, and follows the order js/game_manager.js L123-L127
//   moved a tile in: remove at the pre-update coordinates, then update the
//   position, then insert. `cells[x][y]` is written directly only by the
//   lattice rebuild a resize performs, and every slot it leaves holds a `Tile`
//   or `null`.
//
// This module reads no DOM, performs no I/O, consumes no randomness, reads no
// clock, holds no mutable module state and reports nothing: a refused command
// is reported to its caller as `false`, and the bus counts what was applied.
//
// Provenance — js/game_manager.js and js/grid.js constructs the applier writes
// through:
//   js/game_manager.js L123-L127  moveTile()          -> `moveTile`
//   js/game_manager.js L69-L76    addRandomTile()     -> `insertTile`
//   js/game_manager.js L36-L45    setup() rehydration -> `restoreBoard`
//   js/grid.js         L7-L19     Grid.empty()        -> the resize rebuild
//   js/grid.js         L89-L91    insertTile()        -> every insertion
//   js/grid.js         L93-L95    removeTile()        -> every removal
// Target rows TR-EFFECTS-01 through TR-EFFECTS-07 of
// docs/TRACEABILITY_MATRIX.md, one per command. Decisions behind this file are
// recorded in docs/DECISION_LOG.md.

import { Tile } from './tile';
import type {
  CellMatrix,
  Position,
  SerializedGrid,
  SerializedTile,
} from './types';
import type { Grid } from './grid';
import type {
  MergePredicate,
  RulesConfig,
} from '../config/rules-config';

/* --------------------------------------------------------------------------
 * Bounds
 * ----------------------------------------------------------------------- */

/**
 * Commands one handler may record. A handler reaching this ceiling has its
 * further commands refused rather than growing the queue without bound; the
 * largest legitimate effect is a shuffle of a full board, which records one
 * command per cell.
 */
const MAX_QUEUED_EFFECTS = 512;

/** Smallest edge length a resize may leave. */
const MIN_EFFECT_BOARD_SIZE = 2;

/**
 * Largest edge length a resize may leave, matching `MAX_BOARD_SIZE` of
 * src/config/default-config.ts. Declared here rather than imported so this
 * module names no configuration module beyond its type import.
 */
const MAX_EFFECT_BOARD_SIZE = 16;

/* --------------------------------------------------------------------------
 * The recorded commands
 * ----------------------------------------------------------------------- */

/** Every command name, in declaration order. */
export const BOARD_EFFECT_NAMES = Object.freeze([
  'insertTile',
  'removeTile',
  'moveTile',
  'restoreBoard',
  'resizeBoard',
  'setMergePredicate',
  'setSpawnWeights',
] as const);

/** Name of one recorded command. */
export type BoardEffectName = (typeof BOARD_EFFECT_NAMES)[number];

/** Inserts a tile of `value` into an empty in-bounds cell. */
interface InsertTileEffect {
  readonly kind: 'insertTile';
  readonly cell: Position;
  readonly value: number;
}

/** Removes whatever tile occupies `cell`. */
interface RemoveTileEffect {
  readonly kind: 'removeTile';
  readonly cell: Position;
}

/** Relocates the tile at `from` into the empty cell `to`. */
interface MoveTileEffect {
  readonly kind: 'moveTile';
  readonly from: Position;
  readonly to: Position;

  /**
   * Whether the relocated tile records where it came from, which is what makes
   * a view tween it rather than pop it as a spawn (js/tile.js L6-L7, L10-L17).
   */
  readonly tween: boolean;
}

/** Replaces the whole lattice with the tiles a snapshot carries. */
interface RestoreBoardEffect {
  readonly kind: 'restoreBoard';
  readonly snapshot: SerializedGrid;

  // TR-EFFECT-01: the score a restore reinstates alongside the lattice, which
  // an undo needs so the points a withdrawn move scored are withdrawn with it.
  // Written by src/engine/engine.ts, not here: the score is the engine's, and
  // this module writes only the board and the rules.
  readonly score?: number;
}

/** Rebuilds the lattice at `size` and writes that size into the rules. */
interface ResizeBoardEffect {
  readonly kind: 'resizeBoard';
  readonly size: number;
}

/** Substitutes the merge predicate the rules carry. */
interface SetMergePredicateEffect {
  readonly kind: 'setMergePredicate';
  readonly predicate: MergePredicate;
}

/** Substitutes the spawn weights the rules carry. */
interface SetSpawnWeightsEffect {
  readonly kind: 'setSpawnWeights';
  readonly weights: readonly number[];
}

/** One recorded command. */
export type BoardEffect =
  | InsertTileEffect
  | RemoveTileEffect
  | MoveTileEffect
  | RestoreBoardEffect
  | ResizeBoardEffect
  | SetMergePredicateEffect
  | SetSpawnWeightsEffect;

/**
 * A command in DESCRIPTOR form, which `BoardEffectQueue.request()` accepts.
 *
 * TR-EFFECT-02. The named command members are the primary surface; this is the
 * data form of the same commands, for a caller holding a command it did not
 * build inline — a persisted effect, a relic table entry, or a test fixture.
 * Both spellings of a resize's edge length are read (`size` and `boardSize`)
 * and both spellings of a restore's lattice (`snapshot` and `board`), so a
 * descriptor written against either name resolves to the same command.
 */
export type BoardEffectRequest =
  | {
      readonly kind: 'insertTile';
      readonly cell: Position;
      readonly value: number;
    }
  | { readonly kind: 'removeTile'; readonly cell: Position }
  | {
      readonly kind: 'moveTile';
      readonly from: Position;
      readonly to: Position;
      readonly tween?: boolean;
    }
  | {
      readonly kind: 'restoreBoard';
      readonly snapshot?: SerializedGrid;
      readonly board?: SerializedGrid;
      readonly score?: number;
    }
  | {
      readonly kind: 'resizeBoard';
      readonly size?: number;
      readonly boardSize?: number;
    }
  | { readonly kind: 'setMergePredicate'; readonly predicate: MergePredicate }
  | { readonly kind: 'setSpawnWeights'; readonly weights: readonly number[] };

/* --------------------------------------------------------------------------
 * The queue a handler records through
 * ----------------------------------------------------------------------- */

/**
 * The board and rules a handler writes, as commands recorded now and applied
 * later.
 *
 * Every member returns `true` only when the command was accepted, and a
 * refused command changes nothing and is not recorded. Nothing here throws:
 * a coordinate outside the board, a cell already occupied, an empty cell to
 * move from, a size outside the supported range, a predicate that is not
 * callable and a weight list that cannot be drawn from are each refused.
 *
 * The five query members read this queue's PROJECTED board — the live board
 * with every accepted command already applied to it — which is the board the
 * handler's next command will be validated against.
 */
export interface BoardEffectQueue {
  /** Edge length of the projected board. */
  readonly size: number;

  /** Commands recorded and not discarded. */
  readonly length: number;

  /**
   * Commands refused since the queue was opened, and never reset by `clear()`.
   *
   * TR-EFFECT-03. A refusal is not an error and nothing throws on one, so this
   * is how a caller — and the dispatch that counts `engine.effect.refused` —
   * learns that a command the handler believed it recorded changed nothing.
   */
  readonly refused: number;

  /**
   * Records an insertion of a fresh tile.
   *
   * The tile records no previous position, so a view draws it appearing
   * rather than moving, which is the appearance js/tile.js L6-L7 gave a
   * spawned tile.
   *
   * @param cell Empty in-bounds cell to insert into.
   * @param value Face value the tile carries. Must be a positive integer.
   * @returns Whether the command was recorded.
   */
  insertTile(cell: Position, value: number): boolean;

  /**
   * Records a removal.
   *
   * @param cell Occupied in-bounds cell to clear.
   * @returns Whether the command was recorded.
   */
  removeTile(cell: Position): boolean;

  /**
   * Records a relocation.
   *
   * @param from Occupied in-bounds cell the tile stands in.
   * @param to Empty in-bounds cell it relocates to.
   * @param tween Whether the tile records where it came from, so a view moves
   *   it rather than popping it. Defaults to `true`.
   * @returns Whether the command was recorded.
   */
  moveTile(from: Position, to: Position, tween?: boolean): boolean;

  /**
   * Records a whole-board restore from a snapshot.
   *
   * Every tile the snapshot carries at a cell inside the PROJECTED board is
   * restored; a tile beyond it is dropped rather than inserted off-lattice.
   * The snapshot's own `size` does not resize the board — `resizeBoard` is the
   * one command that does.
   *
   * @param snapshot The board to restore, in `Grid.serialize()`'s shape.
   * @returns Whether the command was recorded.
   */
  restoreBoard(snapshot: SerializedGrid, score?: number): boolean;

  /**
   * Records a resize.
   *
   * BOTH size fields are written when this is applied: the lattice's own
   * `size` and the rules' `boardSize`. Every tile beyond the new bound is
   * dropped, so a caller re-homing survivors records its `moveTile` commands
   * BEFORE this one.
   *
   * @param size Edge length to leave, from `MIN_EFFECT_BOARD_SIZE` through
   *   `MAX_EFFECT_BOARD_SIZE`.
   * @returns Whether the command was recorded.
   */
  resizeBoard(size: number): boolean;

  /**
   * Records a merge-predicate substitution.
   *
   * @param predicate Predicate to install.
   * @returns Whether the command was recorded.
   */
  setMergePredicate(predicate: MergePredicate): boolean;

  /**
   * Records a spawn-weight substitution.
   *
   * The list is copied as it is recorded, so a caller may reuse its array.
   *
   * @param weights Weights to install, one per configured spawn value, every
   *   one a finite non-negative number and at least one above zero.
   * @returns Whether the command was recorded.
   */
  setSpawnWeights(weights: readonly number[]): boolean;

  /**
   * Records one command given in DESCRIPTOR form.
   *
   * TR-EFFECT-02. Resolves the descriptor to the matching named member, so a
   * descriptor is validated, projected and recorded by exactly the same code
   * the named member runs — the two forms cannot diverge. An unknown `kind` is
   * refused.
   *
   * @param effect Command to record.
   * @returns `true` when the command was accepted.
   */
  request(effect: BoardEffectRequest): boolean;

  /**
   * Reads the commands recorded and not yet discarded, in record order.
   *
   * @returns A frozen snapshot; recording after this call does not change it.
   */
  requested(): readonly BoardEffect[];

  /**
   * Reads the face value the projected board holds in a cell.
   *
   * @param cell Cell to read.
   * @returns The value, or `null` for an empty or off-lattice cell.
   */
  cellValue(cell: Position): number | null;

  /**
   * Reports whether the projected board holds a tile in a cell.
   *
   * @param cell Cell to test.
   * @returns `true` when the cell holds a tile.
   */
  cellOccupied(cell: Position): boolean;

  /**
   * Lists the projected board's empty cells, x-outer and y-inner — the order
   * js/grid.js L45-L55 collected them in, which a uniform draw resolves
   * against.
   *
   * @returns A fresh array of fresh coordinates.
   */
  availableCells(): Position[];

  /**
   * Lists the projected board's occupied cells with their values, x-outer and
   * y-inner.
   *
   * @returns A fresh array of fresh records.
   */
  occupiedCells(): readonly OccupiedCell[];

  /** Discards every recorded command, leaving the queue empty. */
  clear(): void;
}

/** One occupied cell of a projected board. */
export interface OccupiedCell {
  readonly x: number;
  readonly y: number;
  readonly value: number;
}

/** What `openBoardEffects` accepts besides its collaborators. */
export interface BoardEffectOptions {
  /**
   * Whether the three CELL-LOCAL commands may be recorded — insert, remove and
   * move. `false` refuses all three while leaving the two rules commands and
   * every query working.
   *
   * Defaults to `true`. src/engine/hook-bus.ts passes `false` for `onMerge`
   * alone, which dispatches from inside the move walk.
   */
  readonly lattice?: boolean;

  /**
   * Whether the two WHOLE-LATTICE commands may be recorded — restore and
   * resize. `false` refuses both.
   *
   * Defaults to `true`. src/engine/hook-bus.ts passes `false` for `onMerge` and
   * for `onSpawn`: each rebuilds every cell of the board, and both of those
   * hooks dispatch while the engine is holding a position it has already
   * resolved against the board as it stands.
   */
  readonly rebuild?: boolean;
}

/** The board a queue projects from and the rules a resize writes into. */
export interface BoardEffectSource {
  /** Edge length of the live board. */
  readonly size: number;

  /**
   * Projects the live lattice. Called once per queue, on first use, and never
   * after.
   */
  serialize(): SerializedGrid;
}

/** What `openBoardEffects` returns to the bus: the queue and its resolution. */
export interface BoardEffectTransaction {
  /** The queue handed to the handler on its context. */
  readonly queue: BoardEffectQueue;

  /**
   * Writes every recorded command to the live board and rules, in record
   * order, and then empties the queue.
   *
   * @returns How many commands were written.
   */
  commit(): number;

  /**
   * Drops every recorded command unapplied. Nothing reached the board or the
   * rules, so the board a later handler reads is the board it would have read
   * had this handler never run.
   *
   * @returns How many commands were dropped.
   */
  rollback(): number;
}

/* --------------------------------------------------------------------------
 * Validation helpers
 * ----------------------------------------------------------------------- */

/**
 * Reports whether `value` is a non-negative safe integer.
 *
 * @param value Value to test.
 * @returns `true` for a non-negative safe integer.
 */
function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reports whether `value` is a face value a tile can carry: a positive safe
 * integer.
 *
 * @param value Value to test.
 * @returns `true` for a positive safe integer.
 */
function isTileValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Reads a cell as a pair of indices, or `null` where either coordinate is not
 * one.
 *
 * @param cell Candidate cell, of any shape.
 * @returns A fresh pair, or `null`.
 */
function readCell(cell: unknown): Position | null {
  if (typeof cell !== 'object' || cell === null) {
    return null;
  }

  const candidate = cell as { x?: unknown; y?: unknown };

  if (!isIndex(candidate.x) || !isIndex(candidate.y)) {
    return null;
  }

  return { x: candidate.x, y: candidate.y };
}

/**
 * Reports whether a weight list can be drawn from: at least one entry, every
 * entry a finite number at or above zero, and at least one above zero.
 *
 * @param weights List to test.
 * @returns `true` for a drawable list.
 */
function isDrawableWeights(weights: readonly number[]): boolean {
  if (weights.length === 0) {
    return false;
  }

  let total = 0;

  for (const weight of weights) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      return false;
    }

    total += weight;
  }

  return total > 0;
}

/** The key one cell of a projected board is held under. */
function keyOf(x: number, y: number): string {
  return `${String(x)},${String(y)}`;
}

/* --------------------------------------------------------------------------
 * The projection
 * ----------------------------------------------------------------------- */

/**
 * The board a queue validates against: the live board as it stood when the
 * queue was opened, advanced by every command the queue has accepted.
 */
interface Projection {
  /** Edge length. Advanced by an accepted `resizeBoard`. */
  size: number;

  /** Occupied cells, keyed by `keyOf`, holding face values. */
  readonly occupied: Map<string, number>;
}

/**
 * Builds the projection from a live board.
 *
 * @param source The live board.
 * @returns The projection.
 */
function projectBoard(source: BoardEffectSource): Projection {
  const snapshot = source.serialize();
  const occupied = new Map<string, number>();
  const size = isIndex(snapshot.size) ? snapshot.size : source.size;

  for (let x = 0; x < size; x += 1) {
    const column = snapshot.cells[x];

    if (column === undefined) {
      continue;
    }

    for (let y = 0; y < size; y += 1) {
      const tile = column[y];

      if (tile !== null && tile !== undefined && isTileValue(tile.value)) {
        occupied.set(keyOf(x, y), tile.value);
      }
    }
  }

  return { size, occupied };
}

/**
 * Drops every projected tile that lies outside `size`.
 *
 * @param projection Projection to trim.
 * @param size Edge length to trim to.
 */
function trimProjection(projection: Projection, size: number): void {
  for (const key of [...projection.occupied.keys()]) {
    const [rawX, rawY] = key.split(',');

    if (Number(rawX) >= size || Number(rawY) >= size) {
      projection.occupied.delete(key);
    }
  }
}

/* --------------------------------------------------------------------------
 * The applier
 * ----------------------------------------------------------------------- */

/**
 * Collects the live board's occupants, x-outer and y-inner.
 *
 * Collected into a plain array BEFORE any mutation, which is what keeps a
 * relocation from being made during the traversal that finds it.
 *
 * @param grid Live board.
 * @returns The occupants in traversal order.
 */
function collectTiles(grid: Grid): Tile[] {
  const tiles: Tile[] = [];

  grid.eachCell((_x, _y, tile): void => {
    if (tile !== null) {
      tiles.push(tile);
    }
  });

  return tiles;
}

/**
 * Writes one insertion.
 *
 * @param grid Live board.
 * @param effect Command to apply.
 */
function applyInsert(grid: Grid, effect: InsertTileEffect): void {
  if (!grid.withinBounds(effect.cell)) {
    return;
  }

  grid.insertTile(new Tile(effect.cell, effect.value));
}

/**
 * Writes one removal.
 *
 * @param grid Live board.
 * @param effect Command to apply.
 */
function applyRemove(grid: Grid, effect: RemoveTileEffect): void {
  const tile = grid.cellContent(effect.cell);

  if (tile !== null) {
    grid.removeTile(tile);
  }
}

/**
 * Writes one relocation, in the order js/game_manager.js L123-L127 moved a
 * tile in: remove at the pre-update coordinates, update the position, insert.
 *
 * @param grid Live board.
 * @param effect Command to apply.
 */
function applyMove(grid: Grid, effect: MoveTileEffect): void {
  const tile = grid.cellContent(effect.from);

  if (tile === null || !grid.withinBounds(effect.to)) {
    return;
  }

  if (grid.cellContent(effect.to) !== null) {
    return;
  }

  grid.removeTile(tile);

  if (effect.tween) {
    tile.savePosition();
  }

  tile.updatePosition(effect.to);
  grid.insertTile(tile);
}

/**
 * Writes one whole-board restore.
 *
 * Every occupant is removed first, so the lattice is empty before a single
 * snapshot tile is inserted, and each restored tile records no previous
 * position, so a view draws the restored board appearing.
 *
 * @param grid Live board.
 * @param effect Command to apply.
 */
function applyRestore(grid: Grid, effect: RestoreBoardEffect): void {
  for (const tile of collectTiles(grid)) {
    grid.removeTile(tile);
  }

  const size = grid.size;

  for (let x = 0; x < size; x += 1) {
    const column = effect.snapshot.cells[x];

    if (column === undefined) {
      continue;
    }

    for (let y = 0; y < size; y += 1) {
      const entry = column[y];

      if (entry === null || entry === undefined) {
        continue;
      }

      if (isTileValue(entry.value)) {
        grid.insertTile(new Tile({ x, y }, entry.value));
      }
    }
  }
}

/**
 * Writes one resize: the lattice is rebuilt at the new edge length, both size
 * fields are set, and every tile inside the new bound is re-inserted at the
 * cell it already occupied.
 *
 * A tile beyond the new bound is dropped. It is dropped rather than moved
 * because a caller re-homing survivors records its relocations before this
 * command, so anything still outside the bound here has already been resolved.
 *
 * @param grid Live board.
 * @param config Live rules, whose `boardSize` is written.
 * @param effect Command to apply.
 */
function applyResize(
  grid: Grid,
  config: RulesConfig,
  effect: ResizeBoardEffect,
): void {
  const size = effect.size;
  const survivors = collectTiles(grid).filter(
    (tile): boolean => tile.x < size && tile.y < size,
  );

  // The one structural write in this module: the container itself is replaced
  // so every row and column beyond the new bound is gone and `eachCell`,
  // `availableCells` and `serialize` all agree on the same lattice. Every slot
  // it leaves holds `null` until a survivor is inserted over it.
  const cells: CellMatrix<Tile> = [];

  for (let x = 0; x < size; x += 1) {
    const row: (Tile | null)[] = [];

    cells[x] = row;

    for (let y = 0; y < size; y += 1) {
      row.push(null);
    }
  }

  grid.size = size;
  grid.cells = cells;
  config.boardSize = size;

  for (const tile of survivors) {
    grid.insertTile(tile);
  }
}

/**
 * Writes every recorded command to the live board and rules, in record order.
 *
 * @param effects Commands to write.
 * @param grid Live board.
 * @param config Live rules.
 * @returns How many commands were written.
 */
export function applyBoardEffects(
  effects: readonly BoardEffect[],
  grid: Grid,
  config: RulesConfig,
): number {
  for (const effect of effects) {
    switch (effect.kind) {
      case 'insertTile':
        applyInsert(grid, effect);
        break;
      case 'removeTile':
        applyRemove(grid, effect);
        break;
      case 'moveTile':
        applyMove(grid, effect);
        break;
      case 'restoreBoard':
        applyRestore(grid, effect);
        break;
      case 'resizeBoard':
        applyResize(grid, config, effect);
        break;
      case 'setMergePredicate':
        config.merge.canMerge = effect.predicate;
        break;
      case 'setSpawnWeights':
        config.spawn.weights = [...effect.weights];
        break;
    }
  }

  return effects.length;
}

/* --------------------------------------------------------------------------
 * Opening a transaction
 * ----------------------------------------------------------------------- */

/**
 * Opens one handler's board-effect transaction over the live board and rules.
 *
 * The queue is lazy: the projection is built from `source.serialize()` on the
 * first command or query and not at all for a handler that records neither, so
 * a dispatch over handlers that touch nothing costs no board projection.
 *
 * @param source The board commands are validated against, which is the query
 *   facade the handler also reads.
 * @param grid The live board `commit()` writes.
 * @param config The live rules `commit()` writes.
 * @returns The transaction.
 */
export function openBoardEffects(
  source: BoardEffectSource,
  grid: Grid,
  config: RulesConfig,
  options: BoardEffectOptions = {},
): BoardEffectTransaction {
  // THE DISPATCH-POINT RESTRICTIONS, in two bands.
  //
  // CELL-LOCAL — insert, remove, move. Refused on `onMerge` alone, which is
  // dispatched from inside the move walk of src/engine/move-resolver.ts while it
  // holds tile references and traversal state; a cell written there would
  // invalidate the walk and can corrupt a position. Accepted on `onSpawn`,
  // because inserting one more tile beside the drawn one is exactly what a
  // spawn-family relic is for.
  //
  // WHOLE-LATTICE — restore, resize. Refused on `onMerge` and on `onSpawn`:
  // both rebuild every cell, and both of those hooks dispatch while the engine
  // holds a position it resolved against the board as it stands, so a rebuild
  // underneath it would strand that position.
  //
  // The two RULES commands are accepted on every hook — they change a
  // comparison rather than a cell, which is what `frostbind` re-records its
  // frozen-cell predicate through.
  const latticeWritable = options.lattice !== false;
  const rebuildWritable = options.rebuild !== false;
  const recorded: BoardEffect[] = [];
  let projection: Projection | null = null;
  let refused = 0;

  const project = (): Projection => {
    if (projection === null) {
      projection = projectBoard(source);
    }

    return projection;
  };

  /** Whether one more command may be recorded. */
  const hasRoom = (): boolean => recorded.length < MAX_QUEUED_EFFECTS;

  /** Whether a cell lies inside the projected board. */
  const inside = (cell: Position): boolean => {
    const size = project().size;

    return cell.x < size && cell.y < size;
  };

  const record = (effect: BoardEffect): boolean => {
    recorded.push(effect);

    return true;
  };

  // The commands as written, WITHOUT the refusal tally. The exposed queue below
  // wraps each of these so one place counts a refusal and `request()` reaches
  // exactly the code the named member runs.
  const commands = {
    get size(): number {
      return project().size;
    },

    get length(): number {
      return recorded.length;
    },

    insertTile(rawCell: Position, value: number): boolean {
      if (!latticeWritable) {
        return false;
      }

      const cell = readCell(rawCell);

      if (
        cell === null ||
        !hasRoom() ||
        !isTileValue(value) ||
        !inside(cell) ||
        project().occupied.has(keyOf(cell.x, cell.y))
      ) {
        return false;
      }

      project().occupied.set(keyOf(cell.x, cell.y), value);

      return record({ kind: 'insertTile', cell, value });
    },

    removeTile(rawCell: Position): boolean {
      if (!latticeWritable) {
        return false;
      }

      const cell = readCell(rawCell);

      if (cell === null || !hasRoom() || !inside(cell)) {
        return false;
      }

      if (!project().occupied.delete(keyOf(cell.x, cell.y))) {
        return false;
      }

      return record({ kind: 'removeTile', cell });
    },

    moveTile(rawFrom: Position, rawTo: Position, tween = true): boolean {
      if (!latticeWritable) {
        return false;
      }

      const from = readCell(rawFrom);
      const to = readCell(rawTo);

      if (from === null || to === null || !hasRoom()) {
        return false;
      }

      if (!inside(from) || !inside(to)) {
        return false;
      }

      const occupied = project().occupied;
      const fromKey = keyOf(from.x, from.y);
      const toKey = keyOf(to.x, to.y);
      const value = occupied.get(fromKey);

      if (value === undefined) {
        return false;
      }

      // Relocating a tile onto the cell it already stands in is accepted as a
      // no-op rather than refused, so a caller walking a list of destinations
      // need not special-case the cell it started from.
      if (fromKey === toKey) {
        return true;
      }

      if (occupied.has(toKey)) {
        return false;
      }

      occupied.delete(fromKey);
      occupied.set(toKey, value);

      return record({ kind: 'moveTile', from, to, tween });
    },

    restoreBoard(snapshot: SerializedGrid, score?: number): boolean {
      if (!rebuildWritable) {
        return false;
      }

      if (
        !hasRoom() ||
        typeof snapshot !== 'object' ||
        snapshot === null ||
        !Array.isArray(snapshot.cells)
      ) {
        return false;
      }

      const size = project().size;
      const occupied = project().occupied;
      const restored: SerializedGrid = {
        size,
        cells: [],
      };

      occupied.clear();

      for (let x = 0; x < size; x += 1) {
        const column: unknown = snapshot.cells[x];
        const row: (SerializedTile | null)[] = [];

        restored.cells[x] = row;

        for (let y = 0; y < size; y += 1) {
          const entry = Array.isArray(column) ? column[y] : null;
          const value: unknown =
            typeof entry === 'object' && entry !== null
              ? (entry as { value?: unknown }).value
              : undefined;

          if (!isTileValue(value)) {
            row.push(null);

            continue;
          }

          row.push({ position: { x, y }, value });
          occupied.set(keyOf(x, y), value);
        }
      }

      return record(
        score === undefined
          ? { kind: 'restoreBoard', snapshot: restored }
          : { kind: 'restoreBoard', snapshot: restored, score },
      );
    },

    resizeBoard(size: number): boolean {
      if (!rebuildWritable) {
        return false;
      }

      if (
        !hasRoom() ||
        !isIndex(size) ||
        size < MIN_EFFECT_BOARD_SIZE ||
        size > MAX_EFFECT_BOARD_SIZE
      ) {
        return false;
      }

      const current = project();

      if (size === current.size) {
        return false;
      }

      trimProjection(current, size);
      current.size = size;

      return record({ kind: 'resizeBoard', size });
    },

    setMergePredicate(predicate: MergePredicate): boolean {
      if (!hasRoom() || typeof predicate !== 'function') {
        return false;
      }

      return record({ kind: 'setMergePredicate', predicate });
    },

    setSpawnWeights(weights: readonly number[]): boolean {
      if (!hasRoom() || !Array.isArray(weights)) {
        return false;
      }

      const copied = [...weights];

      if (!isDrawableWeights(copied)) {
        return false;
      }

      return record({ kind: 'setSpawnWeights', weights: copied });
    },

    cellValue(rawCell: Position): number | null {
      const cell = readCell(rawCell);

      if (cell === null || !inside(cell)) {
        return null;
      }

      return project().occupied.get(keyOf(cell.x, cell.y)) ?? null;
    },

    cellOccupied(rawCell: Position): boolean {
      const cell = readCell(rawCell);

      if (cell === null || !inside(cell)) {
        return false;
      }

      return project().occupied.has(keyOf(cell.x, cell.y));
    },

    availableCells(): Position[] {
      const current = project();
      const cells: Position[] = [];

      for (let x = 0; x < current.size; x += 1) {
        for (let y = 0; y < current.size; y += 1) {
          if (!current.occupied.has(keyOf(x, y))) {
            cells.push({ x, y });
          }
        }
      }

      return cells;
    },

    occupiedCells(): readonly OccupiedCell[] {
      const current = project();
      const cells: OccupiedCell[] = [];

      for (let x = 0; x < current.size; x += 1) {
        for (let y = 0; y < current.size; y += 1) {
          const value = current.occupied.get(keyOf(x, y));

          if (value !== undefined) {
            cells.push(Object.freeze({ x, y, value }));
          }
        }
      }

      return Object.freeze(cells);
    },

    clear(): void {
      recorded.length = 0;
      projection = null;
    },
  };

  /**
   * Counts a refusal. THE ONE place a refusal is tallied, so the count cannot
   * disagree with what the commands returned.
   *
   * @param accepted What the command returned.
   * @returns `accepted`, unchanged.
   */
  const tally = (accepted: boolean): boolean => {
    if (!accepted) {
      refused += 1;
    }

    return accepted;
  };

  const queue: BoardEffectQueue = {
    get size(): number {
      return commands.size;
    },

    get length(): number {
      return commands.length;
    },

    get refused(): number {
      return refused;
    },

    insertTile: (cell: Position, value: number): boolean =>
      tally(commands.insertTile(cell, value)),

    removeTile: (cell: Position): boolean => tally(commands.removeTile(cell)),

    moveTile: (from: Position, to: Position, tween?: boolean): boolean =>
      tally(commands.moveTile(from, to, tween)),

    restoreBoard: (snapshot: SerializedGrid, score?: number): boolean =>
      tally(commands.restoreBoard(snapshot, score)),

    resizeBoard: (size: number): boolean => tally(commands.resizeBoard(size)),

    setMergePredicate: (predicate: MergePredicate): boolean =>
      tally(commands.setMergePredicate(predicate)),

    setSpawnWeights: (weights: readonly number[]): boolean =>
      tally(commands.setSpawnWeights(weights)),

    request(effect: BoardEffectRequest): boolean {
      if (typeof effect !== 'object' || effect === null) {
        return tally(false);
      }

      switch (effect.kind) {
        case 'insertTile':
          return tally(commands.insertTile(effect.cell, effect.value));
        case 'removeTile':
          return tally(commands.removeTile(effect.cell));
        case 'moveTile':
          return tally(
            commands.moveTile(effect.from, effect.to, effect.tween),
          );
        case 'restoreBoard': {
          const snapshot = effect.snapshot ?? effect.board;

          return tally(
            snapshot === undefined
              ? false
              : commands.restoreBoard(snapshot, effect.score),
          );
        }
        case 'resizeBoard': {
          const size = effect.size ?? effect.boardSize;

          return tally(
            size === undefined ? false : commands.resizeBoard(size),
          );
        }
        case 'setMergePredicate':
          return tally(commands.setMergePredicate(effect.predicate));
        case 'setSpawnWeights':
          return tally(commands.setSpawnWeights(effect.weights));
        default:
          return tally(false);
      }
    },

    requested: (): readonly BoardEffect[] => Object.freeze([...recorded]),

    cellValue: (cell: Position): number | null => commands.cellValue(cell),

    cellOccupied: (cell: Position): boolean => commands.cellOccupied(cell),

    availableCells: (): Position[] => commands.availableCells(),

    occupiedCells: (): readonly OccupiedCell[] => commands.occupiedCells(),

    clear: (): void => {
      commands.clear();
    },
  };

  return {
    queue: Object.freeze(queue),

    commit(): number {
      if (recorded.length === 0) {
        return 0;
      }

      const written = applyBoardEffects(recorded, grid, config);

      recorded.length = 0;
      projection = null;

      return written;
    },

    rollback(): number {
      const dropped = recorded.length;

      recorded.length = 0;
      projection = null;

      return dropped;
    },
  };
}

/**
 * The queue a handler is handed when the dispatch carries no live board or no
 * live rules to write: every command is refused and every query reads an empty
 * board.
 *
 * A handler therefore never has to test whether it can record, and a dispatch
 * assembled without collaborators cannot be made to write through one.
 */
export const INERT_BOARD_EFFECTS: BoardEffectQueue = Object.freeze({
  size: 0,
  length: 0,
  refused: 0,
  insertTile: (): boolean => false,
  removeTile: (): boolean => false,
  moveTile: (): boolean => false,
  restoreBoard: (): boolean => false,
  resizeBoard: (): boolean => false,
  setMergePredicate: (): boolean => false,
  setSpawnWeights: (): boolean => false,
  request: (): boolean => false,
  requested: (): readonly BoardEffect[] => Object.freeze([]),
  cellValue: (): number | null => null,
  cellOccupied: (): boolean => false,
  availableCells: (): Position[] => [],
  occupiedCells: (): readonly OccupiedCell[] => Object.freeze([]),
  clear: (): void => undefined,
});
