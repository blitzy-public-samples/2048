// The `board-manipulation` relic family: four charge-carrying relics bound to
// the `onBeforeMove` and `onAfterMove` hook points.
//
// Hook provenance. `onBeforeMove` is the seam of js/game_manager.js L134, the
// terminal guard the move opened with, whose `prepareTiles` at L113-L120
// followed it; `onAfterMove` is the seam of L185-L189, the loss check and the
// actuation call that closed the move.
//
// Charges are DECLARED here and deducted in src/engine/hook-bus.ts, which
// skips a handler whose budget is spent and owns the only path that writes a
// budget. A handler that acted calls `HookContext.spendCharge` to mark the
// invocation successful; it never reads, compares or writes the count itself.
//
// Each handler ASKS for its charge, through `HookContext.spendCharge()`, on the
// one path where its effect takes hold — the withdrawal for `temporal-anchor`,
// the redirection for `tumbler`, the turn for `culling-blade`, the cleared
// row for `scouring-wind` — and on no other path, so a dispatch that reached
// a handler which then changed nothing spends nothing. Without those calls the
// four budgets declared below were never spent and the relics fired for the
// whole run.
//
// Randomness is drawn from the `relic-draw` substream alone, through the
// per-handler fork src/engine/hooks.ts hands over on `HookContext.rng`.
//
// This module reads no DOM, performs no I/O, reads no clock, holds no
// module-level mutable state and takes no unseeded randomness: the substream
// named above is the only source of draws it reaches for.
//
// The catalogue of families, rarities, hooks and charge counts is
// docs/RELICS.md, and the charge guard and the compounding protocol are
// `Figure 5` of docs/architecture/hook-dispatch-sequence.md. The guard itself is
// src/engine/hook-bus.ts, which its own suites exercise.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, in declaration
// order, all target-only because no vanilla construct declared a relic:
//   TR-BOARD-01  temporal-anchor   onBeforeMove
//   TR-BOARD-02  tumbler           onBeforeMove
//   TR-BOARD-03  culling-blade     onAfterMove
//   TR-BOARD-04  scouring-wind     onAfterMove
//   TR-BOARD-05  the frozen `BOARD_MANIPULATION_FAMILY` export
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, in declaration
// order, all target-only because no vanilla construct declared a relic:
//   TR-BOARD-01  temporal-anchor   onBeforeMove
//   TR-BOARD-02  tumbler           onBeforeMove
//   TR-BOARD-03  culling-blade     onAfterMove
//   TR-BOARD-04  scouring-wind     onAfterMove
//   TR-BOARD-05  the frozen `BOARD_MANIPULATION_FAMILY` export
//
// Decisions: DL-BOARD-01, DL-BOARD-02 (docs/DECISION_LOG.md).

import type {
  HookHandler,
  ReadonlyGridView,
  ReadonlyRulesView,
} from '../../engine/hooks';
import type {
  Position,
  SerializedGrid,
  SerializedTile,
} from '../../engine/types';
import type { StreamName } from '../../rng/rng-streams';
import type { Relic, RelicFamily } from '../relic-types';
import { RARITIES } from '../relic-types';


// Each value below is intrinsic to one relic — its charge budget or its own
// threshold — and is declared here as an immutable constant.

/** Charge budget a run starts `temporal-anchor` with. */
const TEMPORAL_ANCHOR_CHARGES = 3;

/** Charge budget a run starts `tumbler` with. */
const TUMBLER_CHARGES = 3;

/** Charge budget a run starts `culling-blade` with. */
const CULLING_BLADE_CHARGES = 2;

/** Charge budget a run starts `scouring-wind` with. */
const SCOURING_WIND_CHARGES = 1;

/** Share of the board `tumbler`'s scarcity band covers. */
const TUMBLER_TRIGGER_FRACTION = 0.25;

/** Tiles at the lowest spawn value that arm `culling-blade`. */
const CULLING_BLADE_ARMING_TILES = 6;

/** The one substream this module draws from. */
const RELIC_DRAW_STREAM: StreamName = 'relic-draw';


// Both shapes below are JSON data: the run envelope of src/run/run-state.ts
// persists a relic's slot, and src/engine/hook-bus.ts copies it in and out of
// every dispatch.

/**
 * `temporal-anchor`'s slot: the board and the score it holds, or `null` for a
 * relic that has not recorded one yet.
 */
interface AnchorState {
  board: SerializedGrid | null;
  score: number;
}

/** One fully-occupied row, as `scouring-wind` records it. */
interface ScouredRow {
  /** Row index: the fixed `y` the row occupies. */
  y: number;

  /** Face values the row held, in ascending `x` order. */
  values: number[];
}

/** `scouring-wind`'s slot: how many rows it has swept, and the last one. */
interface ScourState {
  scours: number;
  row: ScouredRow | null;
}

/** `temporal-anchor`'s slot before its first move. */
const INITIAL_ANCHOR_STATE: AnchorState = Object.freeze({
  board: null,
  score: 0,
});

/** `scouring-wind`'s slot before its first sweep. */
const INITIAL_SCOUR_STATE: ScourState = Object.freeze({
  scours: 0,
  row: null,
});


// A slot arrives as `unknown`: the run envelope may have persisted it under an
// older build, and storage may return it corrupted.

/**
 * @param value Candidate value.
 * @returns `true` for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reports whether `value` is a finite number.
 *
 * @param value Candidate value.
 * @returns `true` for a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reports whether `value` is usable as a cell coordinate.
 *
 * @param value Candidate coordinate.
 * @returns `true` for a non-negative integer.
 */
function isCellIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Reports whether `value` is one serialised tile: a cell pair and a positive
 * face value, the shape `Tile.serialize` writes.
 *
 * @param value Candidate cell entry.
 * @returns `true` for a serialised tile.
 */
function isSerializedTile(value: unknown): value is SerializedTile {
  if (!isRecord(value)) {
    return false;
  }

  const position: unknown = value.position;
  const face: unknown = value.value;

  return (
    isRecord(position) &&
    isCellIndex(position.x) &&
    isCellIndex(position.y) &&
    isFiniteNumber(face) &&
    face > 0
  );
}

/**
 * Reports whether `value` is one column of a serialised board.
 *
 * @param value Candidate column.
 * @param size Edge length the column is measured against.
 * @returns `true` for a well-formed column.
 */
function isSerializedColumn(value: unknown, size: number): boolean {
  if (!Array.isArray(value) || value.length !== size) {
    return false;
  }

  return value.every(
    (cell: unknown): boolean => cell === null || isSerializedTile(cell),
  );
}

/**
 * Reports whether `value` is a serialised board: a positive `size` and a
 * square `cells` matrix of that edge length.
 *
 * @param value Candidate board.
 * @returns `true` for a well-formed board snapshot.
 */
function isSerializedGrid(value: unknown): value is SerializedGrid {
  if (!isRecord(value)) {
    return false;
  }

  const size: unknown = value.size;
  const cells: unknown = value.cells;

  if (!isCellIndex(size) || size === 0 || !Array.isArray(cells)) {
    return false;
  }

  if (cells.length !== size) {
    return false;
  }

  return cells.every(
    (column: unknown): boolean => isSerializedColumn(column, size),
  );
}

/**
 * Reports whether `value` is `temporal-anchor`'s slot.
 *
 * @param value Candidate slot.
 * @returns `true` for a slot carrying a finite score and either no board or
 *   a well-formed one.
 */
function isAnchorState(value: unknown): value is AnchorState {
  if (!isRecord(value)) {
    return false;
  }

  const board: unknown = value.board;

  return (
    isFiniteNumber(value.score) &&
    (board === null || isSerializedGrid(board))
  );
}

/**
 * Reports whether `value` is `scouring-wind`'s slot.
 *
 * @param value Candidate slot.
 * @returns `true` for a slot carrying a finite sweep count.
 */
function isScourState(value: unknown): value is ScourState {
  return isRecord(value) && isFiniteNumber(value.scours);
}


// Every reader below walks the board x-outer and y-inner, the order js/grid.js
// L45-L64 walked it in and the order `availableCells` still reports, and reads
// face values through `cellValue`, the view's stand-in for `cellContent`.

/**
 * Cells a square board of `size` holds.
 *
 * @param size Edge length, read from the rules in force.
 * @returns The cell count, and `0` for an unusable edge length.
 */
function cellCount(size: number): number {
  if (!isFiniteNumber(size) || size <= 0) {
    return 0;
  }

  const edge = Math.trunc(size);

  return edge * edge;
}

/**
 * The scarcity band: the highest number of empty cells `tumbler` acts within.
 *
 * @param config The rules in force.
 * @returns The band's upper bound, in cells.
 */
function scarcityBand(config: ReadonlyRulesView): number {
  return Math.ceil(cellCount(config.boardSize) * TUMBLER_TRIGGER_FRACTION);
}

/**
 * The lowest value the spawn distribution in force can produce.
 *
 * @param config The rules in force.
 * @returns The lowest positive spawn value, or `null` where the distribution
 *   declares none.
 */
function lowestSpawnValue(config: ReadonlyRulesView): number | null {
  let lowest: number | null = null;

  for (const value of config.spawn.values) {
    const eligible = isFiniteNumber(value) && value > 0;

    if (eligible && (lowest === null || value < lowest)) {
      lowest = value;
    }
  }

  return lowest;
}

/**
 * Tiles on the board carrying one face value.
 *
 * @param board The board in force.
 * @param value Face value to count.
 * @returns How many cells hold that value.
 */
function countTilesWithValue(
  board: ReadonlyGridView,
  value: number,
): number {
  const size = board.size;
  let found = 0;

  for (let x = 0; x < size; x += 1) {
    for (let y = 0; y < size; y += 1) {
      if (board.cellValue({ x, y }) === value) {
        found += 1;
      }
    }
  }

  return found;
}

/**
 * The first fully-occupied row of the board, scanning rows in ascending `y`
 * and each row in ascending `x`.
 *
 * A ROW is one fixed `y` across every `x`. The store js/grid.js L88-L95 wrote
 * through is x-major — `cells[x][y]`, where `x` selects a column — so a row is
 * read by holding `y` and walking `x`, which is the transpose of the store's own
 * outer index.
 *
 * @param board The board in force.
 * @returns The row's `y` and the values it held, in ascending `x`, or `null`
 *   where no row is fully occupied.
 */
function firstFullRow(board: ReadonlyGridView): ScouredRow | null {
  const size = board.size;

  for (let y = 0; y < size; y += 1) {
    const values: number[] = [];

    for (let x = 0; x < size; x += 1) {
      const value = board.cellValue({ x, y });

      if (value === null) {
        break;
      }

      values.push(value);
    }

    if (values.length === size) {
      return { y, values };
    }
  }

  return null;
}

/**
 * The cell holding the board's lowest face value.
 *
 * @param occupied Occupied cells of the board, in scan order.
 * @returns The cell, or `null` where no cell is occupied.
 */
function lowestOccupiedCell(
  occupied: readonly { readonly x: number; readonly y: number;
    readonly value: number }[],
): Position | null {
  let chosen: Position | null = null;
  let lowest = Number.POSITIVE_INFINITY;

  for (const cell of occupied) {
    if (cell.value < lowest) {
      lowest = cell.value;
      chosen = { x: cell.x, y: cell.y };
    }
  }

  return chosen;
}

/**
 * Cells of a held anchor that still fall on the live board.
 *
 * @param snapshot Board the anchor holds.
 * @param board The board in force.
 * @param config The rules in force.
 * @returns How many of the anchor's occupied cells are still on the board.
 */
function usableAnchorCells(
  snapshot: SerializedGrid,
  board: ReadonlyGridView,
  config: ReadonlyRulesView,
): number {
  let usable = 0;

  for (const column of snapshot.cells) {
    for (const cell of column) {
      if (cell !== null && isOnLiveBoard(cell.position, board, config)) {
        usable += 1;
      }
    }
  }

  return usable;
}

/**
 * Reports whether one cell falls inside both the live lattice and the edge
 * length the rules in force declare.
 *
 * @param position Cell to test.
 * @param board The board in force.
 * @param config The rules in force.
 * @returns `true` when the cell is addressable on the live board.
 */
function isOnLiveBoard(
  position: Position,
  board: ReadonlyGridView,
  config: ReadonlyRulesView,
): boolean {
  return (
    board.withinBounds(position) &&
    position.x < config.boardSize &&
    position.y < config.boardSize
  );
}

// Each transform below takes the lattice `ReadonlyGridView.serialize` returned
// — a fresh `{ size, cells }` per call, so writing into it reaches no board —
// and returns the lattice a `restoreBoard` effect is requested with.
// src/engine/engine.ts is the only writer of a board: a handler asks, and the
// engine applies the request once the handler has returned and its return has
// been accepted.





// Each handler returns the payload it resolves to and records its board change
// through `HookContext.effects`, which src/engine/board-effects.ts applies to
// the live lattice once the handler has returned and its return has validated.

/**
 * `temporal-anchor` on `onAfterMove`: records the board the move settled on,
 * together with the score it settled at, replacing any anchor already held —
 * but only while that board still holds an empty cell.
 *
 * @param payload The resolved move.
 * @param context The dispatch's collaborators and this relic's slot.
 * @returns The payload, unchanged.
 */
const recordAnchor: HookHandler<'onAfterMove'> = (payload, context) => {
  // The last position with room, not simply the last position.
  if (!payload.board.cellsAvailable()) {
    return payload;
  }

  const anchor: AnchorState = {
    board: payload.board.serialize(),
    score: payload.score,
  };

  context.state = anchor;

  return payload;
};

/**
 * `temporal-anchor` on `onBeforeMove`: while the board holds no empty cell and
 * an anchor is held, REWINDS the board to the anchored position and withdraws
 * the move.
 *
 * @param payload The requested move.
 * @param context The dispatch's collaborators and this relic's slot.
 * @returns The payload, withdrawn where the anchor holds.
 */
const holdAnchor: HookHandler<'onBeforeMove'> = (payload, context) => {
  if (payload.board.cellsAvailable()) {
    return payload;
  }

  const held: unknown = context.state;

  if (!isAnchorState(held) || held.board === null) {
    return payload;
  }

  const standing = usableAnchorCells(
    held.board,
    payload.board,
    context.config,
  );

  if (standing === 0) {
    return payload;
  }

  // A move another relic already withdrew is withdrawn: the anchor adds
  // nothing to it, so it neither rewinds nor pays for it.
  if (payload.cancelled) {
    return payload;
  }

  // THE UNDO.
  if (!context.effects.restoreBoard(held.board, held.score)) {
    return payload;
  }

  context.state = { board: null, score: held.score };

  payload.cancelled = true;

  // The rewind is the effect, so the charge is asked for here and on no other
  // path: a turn that found no jam, held no usable anchor, or had its restore
  // refused pays nothing.
  context.spendCharge();

  return payload;
};

/**
 * `tumbler` on `onBeforeMove`: while the empty cells left are inside the
 * scarcity band, the board tumbles — every tile relocates to a cell drawn from
 * those standing empty at the moment it is placed.
 *
 * @param payload The requested move.
 * @param context The dispatch's collaborators and its effect queue.
 * @returns The payload, unchanged.
 */
const tumbleMove: HookHandler<'onBeforeMove'> = (payload, context) => {
  const empty = payload.board.availableCells().length;

  if (empty === 0 || empty > scarcityBand(context.config)) {
    return payload;
  }

  const effects = context.effects;
  const stream = context.rng.stream(RELIC_DRAW_STREAM);

  let relocated = 0;

  for (const tile of effects.occupiedCells()) {
    const destination = stream.pick(effects.availableCells());

    if (destination === undefined) {
      break;
    }

    if (effects.moveTile({ x: tile.x, y: tile.y }, destination)) {
      relocated += 1;
    }
  }

  // The tumble is the effect, and it is one effect however many tiles it
  // moved, so one charge is asked for once at least one tile was actually
  // relocated.
  if (relocated > 0) {
    context.spendCharge();
  }

  return payload;
};

/**
 * `culling-blade` on `onBeforeMove`: while the board is still open and the
 * lowest spawn value has piled up on it, the blade EXCISES the single
 * lowest-valued tile on the board.
 *
 * @param payload The requested move.
 * @param context The dispatch's collaborators and its effect queue.
 * @returns The payload, unchanged.
 */
const cullSmallest: HookHandler<'onBeforeMove'> = (payload, context) => {
  const empty = payload.board.availableCells().length;

  if (empty <= scarcityBand(context.config)) {
    return payload;
  }

  const lowest = lowestSpawnValue(context.config);

  if (lowest === null) {
    return payload;
  }

  if (countTilesWithValue(payload.board, lowest) < CULLING_BLADE_ARMING_TILES) {
    return payload;
  }

  // The excision. The single lowest-valued tile is removed, chosen by face
  // value and, among equal values, by the x-outer y-inner scan order — so the
  // same board always yields the same excision and no draw is taken.
  const effects = context.effects;
  const target = lowestOccupiedCell(effects.occupiedCells());

  if (target === null) {
    return payload;
  }

  // The excision is the effect, so the charge is asked for only where the
  // removal was actually recorded: a board the blade found nothing to take
  // from pays nothing.
  if (effects.removeTile(target)) {
    context.spendCharge();
  }

  return payload;
};

/**
 * `scouring-wind` on `onAfterMove`: sweeps the settled board for the first
 * fully-occupied ROW — one row being a single `y` across every `x` — and CLEARS
 * every tile standing in it. The row-clear effect AAP §0.1.2.5 names among the
 * charge-based relics.
 *
 * Every cell of the row is collected before a single removal is recorded.
 * Takes no draw, awards no score and returns the payload as it stands, so the
 * score, the win flag and the loss flag the move resolved to are the ones the
 * engine adopts.
 *
 * @param payload The resolved move.
 * @param context The dispatch's collaborators and this relic's slot.
 * @returns The payload, unchanged.
 */
const sweepRow: HookHandler<'onAfterMove'> = (payload, context) => {
  const row = firstFullRow(payload.board);

  if (row === null) {
    return payload;
  }

  // THE LINE CLEAR. The first fully-occupied row is emptied outright, one
  // removal per cell, in ascending `x` and taking no draw. Nothing is moved, so
  // every tile outside that row keeps the exact cell it occupied, and the loss
  // probe that follows this dispatch reads the cleared board.
  const effects = context.effects;
  let cleared = 0;

  for (let x = 0; x < row.values.length; x += 1) {
    if (effects.removeTile({ x, y: row.y })) {
      cleared += 1;
    }
  }

  const held: unknown = context.state;
  const record: ScourState = {
    scours: (isScourState(held) ? held.scours : 0) + 1,
    row,
  };

  context.state = record;

  // THE LINE CLEAR IS THE EFFECT, one effect however many cells it emptied, so
  // one charge is asked for once a full row was found AND cleared. A move that
  // settled on a board with no full row leaves nothing to clear and pays
  // nothing.
  if (cleared > 0) {
    context.spendCharge();
  }

  return payload;
};


// Each relic carries the seven members `Relic` declares and no others: the
// family is the exported record's `name`, and the behaviour is the handlers
// bound in `hooks`.

/** Undo, on the common tier: rewinds a full board to its last record. */
const TEMPORAL_ANCHOR: Relic = Object.freeze({
  id: 'temporal-anchor',
  name: 'Temporal Anchor',
  rarity: RARITIES[0],
  description:
    'Records the last position that still had room, and the score with it. ' +
    'Once the board holds no empty cell, the anchor pulls the board and your ' +
    'score back to that position and withdraws the move. Limited charges.',
  hooks: Object.freeze({
    onAfterMove: recordAnchor,
    onBeforeMove: holdAnchor,
  }),
  charges: TEMPORAL_ANCHOR_CHARGES,
  state: INITIAL_ANCHOR_STATE,
});

/** Shuffle, on the uncommon tier: throws every tile under scarcity. */
const TUMBLER: Relic = Object.freeze({
  id: 'tumbler',
  name: 'Tumbler',
  rarity: RARITIES[1],
  description:
    'While a quarter of the board or less is empty, it tumbles: every tile ' +
    'is thrown to a seeded new cell before your move resolves against the ' +
    'board it leaves. Limited charges.',
  hooks: Object.freeze({
    onBeforeMove: tumbleMove,
  }),
  charges: TUMBLER_CHARGES,
});

/** Excise, on the rare tier: removes the board's lowest tile. */
const CULLING_BLADE: Relic = Object.freeze({
  id: 'culling-blade',
  name: 'Culling Blade',
  rarity: RARITIES[2],
  description:
    'While the board is still open and the smallest tiles have piled up, ' +
    'the blade excises the single lowest tile on the board. Awards no ' +
    'score. Limited charges.',
  hooks: Object.freeze({
    onBeforeMove: cullSmallest,
  }),
  charges: CULLING_BLADE_CHARGES,
});

/** Row clear, on the legendary tier: clears a fully-occupied row. */
const SCOURING_WIND: Relic = Object.freeze({
  id: 'scouring-wind',
  name: 'Scouring Wind',
  rarity: RARITIES[3],
  description:
    'After every move, sweeps away the first fully-occupied row — one row ' +
    'being a single y across every x — and clears every tile standing in it. ' +
    'Awards no score. Limited charges.',
  hooks: Object.freeze({
    onAfterMove: sweepRow,
  }),
  charges: SCOURING_WIND_CHARGES,
  state: INITIAL_SCOUR_STATE,
});


/** The `board-manipulation` family, and this module's whole export. */
export const BOARD_MANIPULATION_FAMILY: RelicFamily = Object.freeze({
  name: 'board-manipulation',
  relics: Object.freeze([
    TEMPORAL_ANCHOR,
    TUMBLER,
    CULLING_BLADE,
    SCOURING_WIND,
  ]),
});
