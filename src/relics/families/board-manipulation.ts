// The `board-manipulation` relic family: four charge-carrying relics bound to
// the `onBeforeMove` and `onAfterMove` hook points.
//
// Hook provenance. `onBeforeMove` is the seam of js/game_manager.js L134, the
// terminal guard the move opened with, whose `prepareTiles()` at L113-L120
// followed it; `onAfterMove` is the seam of L185-L189, the loss check and the
// actuation call that closed the move.
//
// What a handler here can reach. src/engine/hook-bus.ts substitutes
// `ReadonlyGridView` for the live `Grid` once per dispatch, before the first
// handler runs, so `insertTile`, `removeTile`, the `cells` matrix and every
// live `Tile` are absent from a handler's reach; it then measures a returned
// payload against the exact member set its hook declares and against the
// identity of the board it arrived with. The board is therefore READ here —
// `availableCells`, `cellValue`, `cellsAvailable`, `withinBounds`,
// `serialize` — and the effects below are carried by the payload members the
// hooks declare transformable, `direction` and `cancelled`, and by each
// relic's own persisted `state` slot.
//
// Charges are DECLARED here and guarded in src/engine/hook-bus.ts, which
// skips a handler whose budget is spent and owns the only path that deducts
// from it: no handler below reads, compares or writes a charge budget.
//
// Randomness is drawn from the `relic-draw` substream alone, through the
// per-handler fork src/engine/hooks.ts hands over on `HookContext.rng`.
//
// This module reads no DOM, performs no I/O, reads no clock, holds no
// module-level mutable state and takes no unseeded randomness: the substream
// named above is the only source of draws it reaches for.
//
// A target row of docs/TRACEABILITY_MATRIX.md. The catalogue of families,
// rarities, hooks and charge counts is docs/RELICS.md; the charge guard and
// the compounding protocol are the named figure of
// docs/architecture/hook-dispatch-sequence.md.

import type {
  HookHandler,
  ReadonlyGridView,
  ReadonlyRulesView,
} from '../../engine/hooks';
import type {
  Direction,
  Position,
  SerializedGrid,
  SerializedTile,
} from '../../engine/types';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
} from '../../engine/types';
import type { StreamName } from '../../rng/rng-streams';
import type { Relic, RelicFamily } from '../relic-types';
import { RARITIES } from '../relic-types';


/* --------------------------------------------------------------------------
 * Relic magnitudes
 * ----------------------------------------------------------------------- */

// Each value below is intrinsic to one relic — its charge budget or its own
// threshold — and is declared here as an immutable constant. Every GAME RULE
// a handler needs, `boardSize` and the spawn distribution included, is read
// from `HookContext.config` at use time instead.

/** Charge budget a run starts `temporal-anchor` with. */
const TEMPORAL_ANCHOR_CHARGES = 3;

/** Charge budget a run starts `tumbler` with. */
const TUMBLER_CHARGES = 3;

/** Charge budget a run starts `culling-blade` with. */
const CULLING_BLADE_CHARGES = 2;

/** Charge budget a run starts `scouring-wind` with. */
const SCOURING_WIND_CHARGES = 1;

/**
 * Share of the board `tumbler`'s scarcity band covers.
 *
 * Multiplied by the live cell count and rounded up, so the band follows the
 * `boardSize` in force at each dispatch.
 */
const TUMBLER_TRIGGER_FRACTION = 0.25;

/**
 * Tiles at the lowest spawn value that arm `culling-blade`.
 */
const CULLING_BLADE_ARMING_TILES = 6;

/**
 * The four move directions, frozen, in the order a draw indexes them and a
 * tie between them resolves.
 */
const MOVE_DIRECTIONS: readonly Direction[] = Object.freeze([
  DIRECTION_UP,
  DIRECTION_RIGHT,
  DIRECTION_DOWN,
  DIRECTION_LEFT,
]);

/** The one substream this module draws from. */
const RELIC_DRAW_STREAM: StreamName = 'relic-draw';


/* --------------------------------------------------------------------------
 * State-slot shapes
 * ----------------------------------------------------------------------- */

// Both shapes below are JSON data: the run envelope of src/run/run-state.ts
// persists a relic's slot, and src/engine/hook-bus.ts copies it in and out of
// every dispatch. Neither carries a `Tile`, a `Grid`, a function or a cycle.

/**
 * `temporal-anchor`'s slot: the board and the score it holds, or `null` for a
 * relic that has not recorded one yet.
 *
 * `board` is exactly what `ReadonlyGridView.serialize()` returns — `{ size,
 * cells }`, occupied cells as `{ position, value }` and empty cells kept as
 * `null` — so the anchor and the persisted board snapshot are one shape.
 */
interface AnchorState {
  board: SerializedGrid | null;
  score: number;
}

/** One fully-occupied column, as `scouring-wind` records it. */
interface ScouredColumn {
  /** Column index: the fixed `x` the column occupies. */
  x: number;

  /** Face values the column held, in ascending `y` order. */
  values: number[];
}

/** `scouring-wind`'s slot: how many columns it has swept, and the last one. */
interface ScourState {
  scours: number;
  column: ScouredColumn | null;
}

/** `temporal-anchor`'s slot before its first move. */
const INITIAL_ANCHOR_STATE: AnchorState = Object.freeze({
  board: null,
  score: 0,
});

/** `scouring-wind`'s slot before its first sweep. */
const INITIAL_SCOUR_STATE: ScourState = Object.freeze({
  scours: 0,
  column: null,
});


/* --------------------------------------------------------------------------
 * Structural predicates
 * ----------------------------------------------------------------------- */

// A slot arrives as `unknown`: the run envelope may have persisted it under
// an older build, and storage may return it corrupted. Each predicate below
// decides one shape and returns a verdict, so a slot that fails any of them
// resolves to "nothing held". src/engine/hook-bus.ts is where a throw from a
// handler is caught, reported through the injected reporter and the relic
// marked degraded.

/**
 * Reports whether `value` is a plain keyed object rather than an array.
 *
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
 * face value, the shape `Tile.serialize()` writes.
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
 * Reports whether `value` is one column of a serialised board: `size`
 * entries, each a serialised tile or `null`.
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
 * @returns `true` for a slot carrying a finite score and either no board or a
 *   well-formed one.
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


/* --------------------------------------------------------------------------
 * Board readers
 * ----------------------------------------------------------------------- */

// Every reader below walks the board x-outer and y-inner, the order
// js/grid.js L45-L64 walked it in and the order `availableCells()` still
// reports, and reads face values through `cellValue`, the view's stand-in for
// `cellContent`. None of them sorts, filters or copies a list a draw resolves
// against.

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
 * The cell one step along one line of the board, in a direction's own
 * traversal order: the leading edge is step `0`, so the sequence a reader
 * collects is the sequence the move resolver would press the line into.
 *
 * @param direction Direction the line is read in.
 * @param line Index of the line: the fixed `x` on a vertical direction, the
 *   fixed `y` on a horizontal one.
 * @param step Distance from the leading edge, in cells.
 * @param size Edge length of the board.
 * @returns The cell at that step.
 */
function lineCell(
  direction: Direction,
  line: number,
  step: number,
  size: number,
): Position {
  const last = size - 1;

  switch (direction) {
    case DIRECTION_UP: {
      return { x: line, y: step };
    }

    case DIRECTION_RIGHT: {
      return { x: last - step, y: line };
    }

    case DIRECTION_DOWN: {
      return { x: line, y: last - step };
    }

    default: {
      // DIRECTION_LEFT, the remaining member of `Direction`.
      return { x: step, y: line };
    }
  }
}

/**
 * Face values one line holds, in the direction's traversal order and with its
 * empty cells left out.
 *
 * @param board The board in force.
 * @param direction Direction the line is read in.
 * @param line Index of the line.
 * @returns The occupied values, leading edge first.
 */
function lineValues(
  board: ReadonlyGridView,
  direction: Direction,
  line: number,
): number[] {
  const size = board.size;
  const values: number[] = [];

  for (let step = 0; step < size; step += 1) {
    const value = board.cellValue(lineCell(direction, line, step, size));

    if (value !== null) {
      values.push(value);
    }
  }

  return values;
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
 * Pairs of neighbouring equal values one pressed line would collapse.
 *
 * Walks the line's occupied values in order and pairs the first two adjacent
 * entries that both carry `target`, then resumes past them, which is the one
 * merge per pair js/game_manager.js L156 allowed.
 *
 * @param values Occupied values of one line, leading edge first.
 * @param target Face value the pairs are counted for.
 * @returns How many pairs of that value the line would collapse.
 */
function countCollapsingPairs(
  values: readonly number[],
  target: number,
): number {
  let pairs = 0;
  let index = 0;

  while (index + 1 < values.length) {
    if (values[index] === target && values[index + 1] === target) {
      pairs += 1;
      index += 2;
    } else {
      index += 1;
    }
  }

  return pairs;
}

/**
 * Pairs of one value the whole board would collapse if it were pressed in one
 * direction.
 *
 * @param board The board in force.
 * @param direction Direction to measure.
 * @param target Face value the pairs are counted for.
 * @returns The board's total for that direction.
 */
function countCullablePairs(
  board: ReadonlyGridView,
  direction: Direction,
  target: number,
): number {
  let pairs = 0;

  for (let line = 0; line < board.size; line += 1) {
    pairs += countCollapsingPairs(lineValues(board, direction, line), target);
  }

  return pairs;
}

/**
 * The direction that collapses the most pairs of one value.
 *
 * Ties resolve to the earlier entry of `MOVE_DIRECTIONS`, so the choice is
 * fixed by the board alone and takes no draw.
 *
 * @param board The board in force.
 * @param target Face value to cull.
 * @returns The direction, or `null` where no direction collapses a pair.
 */
function chooseCullingDirection(
  board: ReadonlyGridView,
  target: number,
): Direction | null {
  let chosen: Direction | null = null;
  let best = 0;

  for (const direction of MOVE_DIRECTIONS) {
    const pairs = countCullablePairs(board, direction, target);

    if (pairs > best) {
      best = pairs;
      chosen = direction;
    }
  }

  return chosen;
}

/**
 * The first fully-occupied column of the board, scanning columns in ascending
 * `x` and each column in ascending `y`.
 *
 * A column is one fixed `x` across every `y`, which is the outer index of the
 * x-major `cells[x][y]` store js/grid.js L88-L95 wrote through.
 *
 * @param board The board in force.
 * @returns The column and the values it held, or `null` where no column is
 *   fully occupied.
 */
function firstFullColumn(board: ReadonlyGridView): ScouredColumn | null {
  const size = board.size;

  for (let x = 0; x < size; x += 1) {
    const values = lineValues(board, DIRECTION_UP, x);

    if (values.length === size) {
      return { x, values };
    }
  }

  return null;
}

/**
 * Cells of a held anchor that still fall on the live board.
 *
 * `withinBounds` reads the board's own edge length at call time and
 * `config.boardSize` is the edge length the rules in force declare, so an
 * anchor recorded at another size is measured against both rather than
 * trusted for the `size` it carries.
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


/* --------------------------------------------------------------------------
 * Handlers
 * ----------------------------------------------------------------------- */

// Each handler returns the payload it resolves to. None reads a charge
// budget. The three trigger conditions on `onBeforeMove` are disjoint:
// `holdAnchor` acts on a board with no empty cell, `tumbleMove` inside the
// scarcity band above that, and `cullSmallest` only above the band.

/**
 * `temporal-anchor` on `onAfterMove`: records the board the move settled on,
 * together with the score it settled at, replacing any anchor already held.
 *
 * The anchor is taken AFTER the move, so it is the position the next
 * `onBeforeMove` measures.
 *
 * @param payload The resolved move.
 * @param context The dispatch's collaborators and this relic's slot.
 * @returns The payload, unchanged.
 */
const recordAnchor: HookHandler<'onAfterMove'> = (payload, context) => {
  const anchor: AnchorState = {
    board: payload.board.serialize(),
    score: payload.score,
  };

  context.state = anchor;

  return payload;
};

/**
 * `temporal-anchor` on `onBeforeMove`: while the board holds no empty cell
 * and an anchor is held, withdraws the move so the anchored position stands.
 *
 * Withdrawing is the veto js/game_manager.js L134 expressed by returning
 * before the move resolved: a withdrawn move moves no tile, resolves no
 * merge, spawns nothing and changes no score.
 *
 * A slot that is absent, malformed, empty, or recorded at cells that no
 * longer fall on the live board holds nothing to stand on, and the move
 * proceeds untouched.
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

  payload.cancelled = true;

  return payload;
};

/**
 * `tumbler` on `onBeforeMove`: while the empty cells left are inside the
 * scarcity band, the board tumbles and the move comes out in a direction
 * drawn from the `relic-draw` substream instead of the one requested.
 *
 * Never withdraws the move: the requested turn still resolves, along the
 * drawn axis, against the board as it stands.
 *
 * One draw per tumble. `pick` on an empty candidate list yields `undefined`
 * and takes no draw, and the move then proceeds untouched.
 *
 * @param payload The requested move.
 * @param context The dispatch's collaborators and this relic's substreams.
 * @returns The payload, redirected where the board tumbles.
 */
const tumbleMove: HookHandler<'onBeforeMove'> = (payload, context) => {
  const empty = payload.board.availableCells().length;

  if (empty === 0 || empty > scarcityBand(context.config)) {
    return payload;
  }

  const drawn = context.rng.stream(RELIC_DRAW_STREAM).pick(MOVE_DIRECTIONS);

  if (drawn === undefined) {
    return payload;
  }

  return {
    direction: drawn,
    board: payload.board,
    cancelled: payload.cancelled,
  };
};

/**
 * `culling-blade` on `onBeforeMove`: while the board is still open and the
 * lowest spawn value has piled up on it, the blade turns the move onto the
 * axis that collapses the most tiles of that value.
 *
 * Takes no draw: the count is read off the board and a tie resolves by
 * direction order, so the same board yields the same axis every time. Never
 * withdraws the move and never touches the score.
 *
 * @param payload The requested move.
 * @param context The dispatch's collaborators.
 * @returns The payload, turned where the blade acts.
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

  const direction = chooseCullingDirection(payload.board, lowest);

  if (direction === null) {
    return payload;
  }

  return {
    direction,
    board: payload.board,
    cancelled: payload.cancelled,
  };
};

/**
 * `scouring-wind` on `onAfterMove`: sweeps the settled board for the first
 * fully-occupied column and records it, with the running count of sweeps, on
 * the relic's own slot.
 *
 * Takes no draw, awards no score and returns the payload as it stands, so the
 * score, the win flag and the loss flag the move resolved to are the ones the
 * engine adopts.
 *
 * @param payload The resolved move.
 * @param context The dispatch's collaborators and this relic's slot.
 * @returns The payload, unchanged.
 */
const sweepColumn: HookHandler<'onAfterMove'> = (payload, context) => {
  const column = firstFullColumn(payload.board);

  if (column === null) {
    return payload;
  }

  const held: unknown = context.state;
  const swept: ScourState = {
    scours: (isScourState(held) ? held.scours : 0) + 1,
    column,
  };

  context.state = swept;

  return payload;
};


/* --------------------------------------------------------------------------
 * The family's relics
 * ----------------------------------------------------------------------- */

// Each relic carries the seven members `Relic` declares and no others: the
// family is the exported record's `name`, and the behaviour is the handlers
// bound in `hooks`. Each rarity is read from one ordinal position of
// `RARITIES`, in the order the four are declared below.

/** Undo, on the common tier: withdraws the move a full board would resolve. */
const TEMPORAL_ANCHOR: Relic = Object.freeze({
  id: 'temporal-anchor',
  name: 'Temporal Anchor',
  rarity: RARITIES[0],
  description:
    'Records the board and score after every move. While the board holds ' +
    'no empty cell, the anchor holds and your move is withdrawn instead ' +
    'of resolved. Limited charges.',
  hooks: Object.freeze({
    onAfterMove: recordAnchor,
    onBeforeMove: holdAnchor,
  }),
  charges: TEMPORAL_ANCHOR_CHARGES,
  state: INITIAL_ANCHOR_STATE,
});

/** Shuffle, on the uncommon tier: redraws the direction under scarcity. */
const TUMBLER: Relic = Object.freeze({
  id: 'tumbler',
  name: 'Tumbler',
  rarity: RARITIES[1],
  description:
    'While a quarter of the board or less is empty, it tumbles: your move ' +
    'comes out along a seeded direction rather than the one pressed. The ' +
    'move still resolves. Limited charges.',
  hooks: Object.freeze({
    onBeforeMove: tumbleMove,
  }),
  charges: TUMBLER_CHARGES,
});

/** Excise, on the rare tier: turns the move onto the culling axis. */
const CULLING_BLADE: Relic = Object.freeze({
  id: 'culling-blade',
  name: 'Culling Blade',
  rarity: RARITIES[2],
  description:
    'While the board is still open and the smallest tiles have piled up, ' +
    'the blade turns your move onto the axis that collapses the most of ' +
    'them. Awards no score. Limited charges.',
  hooks: Object.freeze({
    onBeforeMove: cullSmallest,
  }),
  charges: CULLING_BLADE_CHARGES,
});

/** Row clear, on the legendary tier: sweeps for a fully-occupied column. */
const SCOURING_WIND: Relic = Object.freeze({
  id: 'scouring-wind',
  name: 'Scouring Wind',
  rarity: RARITIES[3],
  description:
    'After every move, sweeps for the first fully-occupied column — one ' +
    'column being a single x across every y — and records it on the relic. ' +
    'Awards no score. Limited charges.',
  hooks: Object.freeze({
    onAfterMove: sweepColumn,
  }),
  charges: SCOURING_WIND_CHARGES,
  state: INITIAL_SCOUR_STATE,
});


/* --------------------------------------------------------------------------
 * The family
 * ----------------------------------------------------------------------- */

/**
 * The `board-manipulation` family, and this module's whole export.
 *
 * `relics` is frozen and its order is the declaration order above. That order
 * is carried into the catalogue the reward draw samples, so it is read as a
 * fixed sequence rather than a set.
 */
export const BOARD_MANIPULATION_FAMILY: RelicFamily = Object.freeze({
  name: 'board-manipulation',
  relics: Object.freeze([
    TEMPORAL_ANCHOR,
    TUMBLER,
    CULLING_BLADE,
    SCOURING_WIND,
  ]),
});
