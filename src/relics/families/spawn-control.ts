// The `spawn-control` relic family: four relics declared as plain data, each
// binding handlers to the engine hooks it acts on.
//
// The family attaches at the `onSpawn` hook point. Its vanilla source is the
// pair of independent decisions js/game_manager.js L69-L76 `addRandomTile`
// made: the spawn VALUE, whose literal is js/game_manager.js L71, and the
// spawn POSITION, drawn by js/grid.js L37-L43 `randomAvailableCell` over the
// x-outer, y-inner cell list of js/grid.js L45-L64. Every relic of the family
// binds `onSpawn` and nothing else.
//
// Every rule parameter is read from `HookContext.config` at use time and every
// draw is taken from the `relic-draw` substream of `HookContext.rng`. Handlers
// transform the payload they are given and return it; the charge guard, the
// dispatch order and the error report all belong to src/engine/hook-bus.ts.
//
// This module reads no DOM, performs no I/O, reads no clock, reports nothing
// and holds no mutable state.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, in declaration
// order, all target-only because no vanilla construct declared a relic:
//   TR-SPAWN-01  twin-seed         onSpawn
//   TR-SPAWN-02  fertile-ground    onSpawn
//   TR-SPAWN-03  prospectors-eye   onSpawn
//   TR-SPAWN-04  loaded-dice       onSpawn
//   TR-SPAWN-05  the frozen `SPAWN_CONTROL_FAMILY` export
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-SPAWN-01  each relic acting through the `onSpawn` payload's `value`,
//                `position` and `count` members alone
//   DL-SPAWN-02  every draw a handler here takes coming from the `relic-draw`
//                substream, so the engine's own `spawn-value` and
//                `spawn-position` sequences are left where the base game put
//                them
//
// The relic catalogue is published in docs/RELICS.md, the rules the relics read
// in docs/CONFIGURATION.md, and hook dispatch in
// docs/architecture/hook-dispatch-sequence.md.
//
// Decisions: DL-SPAWN-01, DL-SPAWN-02 (docs/DECISION_LOG.md).

import { RARITIES, type Relic, type RelicFamily } from '../relic-types';
import type { ReadonlyGridView } from '../../engine/hooks';
import type { Position } from '../../engine/types';
import type { StreamName } from '../../rng/rng-streams';

/** The one substream every handler below draws from. */
const RELIC_DRAW_STREAM: StreamName = 'relic-draw';

/**
 * Probability `twin-seed` promotes a lowest-value spawn, compared against one
 * draw in `[0, 1)`.
 */
const TWIN_SEED_PROMOTION_CHANCE = 0.5;

/**
 * The four orthogonal neighbour offsets `fertile-ground` tests a cell against,
 * walked in this order.
 */
const NEIGHBOUR_OFFSETS: readonly Position[] = Object.freeze([
  Object.freeze({ x: 0, y: -1 }),
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: 0, y: 1 }),
  Object.freeze({ x: -1, y: 0 }),
]);

/**
 * Orders two tile values low to high, for `Array.prototype.sort`, which
 * compares as strings without one.
 *
 * @param left First value.
 * @param right Second value.
 * @returns A negative number, zero or a positive number.
 */
function ascending(left: number, right: number): number {
  return left - right;
}

/**
 * Reports whether two cells are the same cell.
 *
 * @param left First cell.
 * @param right Second cell.
 * @returns `true` when both coordinates match.
 */
function samePosition(left: Position, right: Position): boolean {
  return left.x === right.x && left.y === right.y;
}

/**
 * Reports whether a cell lies inside a square board of edge length `size`.
 *
 * @param cell Cell to test.
 * @param size Edge length read from the rules in force.
 * @returns `true` when both coordinates are within `[0, size)`.
 */
function isWithinBoard(cell: Position, size: number): boolean {
  return cell.x >= 0 && cell.x < size && cell.y >= 0 && cell.y < size;
}

/**
 * Reports whether a cell sits on the outer ring of a square board of edge
 * length `size`: the first or last column, or the first or last row.
 *
 * @param cell Cell to test.
 * @param size Edge length read from the rules in force.
 * @returns `true` when the cell is on the ring.
 */
function isOuterRingCell(cell: Position, size: number): boolean {
  const edge = size - 1;

  return cell.x === 0 || cell.y === 0 || cell.x === edge || cell.y === edge;
}

/**
 * Reports whether any of a cell's four orthogonal neighbours holds a tile.
 *
 * @param cell Cell whose neighbours are read.
 * @param grid Board query surface carried by the dispatch.
 * @returns `true` when at least one neighbour holds a tile.
 */
function hasAdjacentTile(cell: Position, grid: ReadonlyGridView): boolean {
  return NEIGHBOUR_OFFSETS.some((offset) =>
    grid.cellOccupied({ x: cell.x + offset.x, y: cell.y + offset.y }),
  );
}

/**
 * Lists the empty cells that satisfy `accept`, in the x-outer, y-inner order
 * `availableCells` returns them in.
 *
 * @param grid Board query surface carried by the dispatch.
 * @param accept Predicate a cell must satisfy to be a candidate.
 * @returns A fresh array of the accepted cells, possibly empty.
 */
function candidateCells(
  grid: ReadonlyGridView,
  accept: (cell: Position) => boolean,
): Position[] {
  return grid.availableCells().filter(accept);
}

/**
 * Promotes a lowest-value spawn to the next configured value above it, part of
 * the time.
 */
const twinSeed: Relic = Object.freeze<Relic>({
  id: 'twin-seed',
  name: 'Twin Seed',
  rarity: RARITIES[0],
  description:
    'Half the time, a newly spawned lowest-value tile arrives as the next ' +
    'value up instead.',

  hooks: Object.freeze({
    onSpawn: (payload, context) => {
      const values = context.config.spawn.values;

      if (values.length < 2) {
        return payload;
      }

      const sorted = values.slice().sort(ascending);
      const lowest = sorted[0];

      if (payload.value !== lowest) {
        return payload;
      }

      // The next value STRICTLY above the lowest.
      const promoted = sorted.find((value) => value > lowest);

      if (promoted === undefined) {
        return payload;
      }

      const draw = context.rng.stream(RELIC_DRAW_STREAM).next();

      if (draw >= TWIN_SEED_PROMOTION_CHANCE) {
        return payload;
      }

      return { ...payload, value: promoted };
    },
  }),
});

/**
 * Sprouts a SECOND tile beside a tile already on the board, leaving the spawn
 * the engine is resolving exactly as it arrived.
 */
const fertileGround: Relic = Object.freeze<Relic>({
  id: 'fertile-ground',
  name: 'Fertile Ground',
  rarity: RARITIES[1],
  description:
    'Every new tile sprouts a second tile of the same value beside a tile ' +
    'already on the board.',

  hooks: Object.freeze({
    onSpawn: (payload, context) => {
      const origin = payload.position;

      if (origin === undefined) {
        return payload;
      }

      const grid = context.grid;
      const size = context.config.boardSize;
      const candidates = candidateCells(
        grid,
        (cell) =>
          isWithinBoard(cell, size) &&
          !samePosition(cell, origin) &&
          hasAdjacentTile(cell, grid),
      );

      if (candidates.length === 0) {
        return payload;
      }

      const chosen = context.rng.stream(RELIC_DRAW_STREAM).pick(candidates);

      if (chosen === undefined) {
        return payload;
      }

      context.effects.insertTile(chosen, payload.value);

      return payload;
    },
  }),
});

/**
 * Steers a spawn onto the outer ring of the board.
 *
 * Binds `onSpawn` alone. The ring is computed from `config.boardSize` as read
 * at the moment of the spawn, which is the live value a board-mutating relic
 * may have changed since the stage began, so there is nothing for the relic to
 * record at stage start and it binds no stage hook. Candidates are filtered to
 * cells inside that edge length as well as on its ring, so a reduced board
 * never yields a cell beyond it.
 */
const prospectorsEye: Relic = Object.freeze<Relic>({
  id: 'prospectors-eye',
  name: "Prospector's Eye",
  rarity: RARITIES[2],
  description:
    'New tiles appear along the edges of the board, leaving the centre clear.',

  hooks: Object.freeze({
    onSpawn: (payload, context) => {
      if (payload.position === undefined) {
        return payload;
      }

      const size = context.config.boardSize;
      const ring = candidateCells(
        context.grid,
        (cell) => isWithinBoard(cell, size) && isOuterRingCell(cell, size),
      );

      if (ring.length === 0) {
        return payload;
      }

      const chosen = context.rng.stream(RELIC_DRAW_STREAM).pick(ring);

      if (chosen === undefined) {
        return payload;
      }

      return { ...payload, position: chosen };
    },
  }),
});

/**
 * Inverts the configured spawn distribution, so the value the rules make
 * rarest becomes the value the board sees most.
 */
const loadedDice: Relic = Object.freeze<Relic>({
  id: 'loaded-dice',
  name: 'Loaded Dice',
  rarity: RARITIES[3],
  description:
    'The spawn odds are turned upside down: the rarest tile value ' +
    'becomes the most common.',

  hooks: Object.freeze({
    onSpawn: (payload, context) => {
      const spawn = context.config.spawn;
      const values = spawn.values;
      const weights = spawn.weights;

      if (values.length === 0 || values.length !== weights.length) {
        return payload;
      }

      const inverted = weights.slice().reverse();
      const drawn = context.rng
        .stream(RELIC_DRAW_STREAM)
        .pickWeighted(values, inverted);

      if (drawn === undefined) {
        return payload;
      }

      return { ...payload, value: drawn };
    },
  }),
});

/**
 * The `spawn-control` family: its name, and its four relics in declaration
 * order.
 *
 * One relic per tier of `RARITIES`, taken by ordinal position.
 */
export const SPAWN_CONTROL_FAMILY: RelicFamily = Object.freeze<RelicFamily>({
  name: 'spawn-control',
  relics: Object.freeze([
    twinSeed,
    fertileGround,
    prospectorsEye,
    loadedDice,
  ]),
});
