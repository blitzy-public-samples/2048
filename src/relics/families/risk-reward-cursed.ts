// The risk-reward-cursed relic family: four relics whose upside is paid for,
// and the family that holds the board-size-mutating relic.
//
// Brand new module: no source-branch file was ported into it. Relic
// declarations, module-level constants and pure helpers only — no registry, no
// draw, no dispatch.
//
// This module reads no DOM, performs no I/O, consumes no randomness, reads no
// clock, reports nothing, holds no mutable module-level state and reads no
// `charges`.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, in declaration
// order, all target-only because no vanilla construct declared a relic:
//   TR-RISK-01  collapsing-vault   onStageEnd
//   TR-RISK-02  gilded-rot         onMerge, onSpawn
//   TR-RISK-03  brittle-crown      onStageStart, onStageEnd
//   TR-RISK-04  hollow-ascension   onMerge, onStageEnd
//   TR-RISK-05  the frozen `RISK_REWARD_CURSED_FAMILY` export
//
// Decisions: DL-RISK-01, DL-RISK-02 (docs/DECISION_LOG.md).

import type {
  HookContext,
  MergePayload,
  SpawnPayload,
  StageEndPayload,
  StageStartPayload,
} from '../../engine/hooks';
import type { StreamName } from '../../rng/rng-streams';
import type { Relic, RelicFamily } from '../relic-types';
import { RARITIES } from '../relic-types';

/** Smallest edge length `collapsing-vault` will collapse a board to. */
const MINIMUM_PLAYABLE_BOARD_SIZE = 3;

/** Cells `collapsing-vault` takes off each edge per cleared stage. */
const BOARD_SHRINK_STEP = 1;

/** Factor `gilded-rot` scales a merge's score contribution by. */
const GILDED_ROT_SCORE_MULTIPLIER = 2;

/**
 * Factor `brittle-crown` raises the draw weight of the highest configured
 * spawn value by.
 */
const BRITTLE_CROWN_SPAWN_SKEW = 4;

/** Fraction of the score `brittle-crown` pays for a cleared stage. */
const BRITTLE_CROWN_CLEAR_BOUNTY = 0.25;

/** Score `hollow-ascension` adds per banked charge. */
const HOLLOW_ASCENSION_BONUS_PER_BANK = 4;

/** Charges `hollow-ascension` banks per merge. */
const HOLLOW_ASCENSION_BANK_STEP = 1;

/** Ceiling `hollow-ascension` clamps its bank to. */
const HOLLOW_ASCENSION_MAX_BANK = 4096;

/** The one substream this module draws from. */
const RELIC_DRAW_STREAM: StreamName = 'relic-draw';

/**
 * Reports whether a value is a plain keyed object: an object that is neither
 * `null` nor an array, which is the shape a JSON state slot round-trips as.
 *
 * @param value Candidate slot.
 * @returns `true` when the value can be read by member name.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the edge length a state slot already declares.
 *
 * @param state The slot as it arrived, of any shape.
 * @returns The declared edge length, or `null` when the slot declares none
 *   usable — which covers an absent slot, a slot of another shape, a
 *   non-integer and anything below the family's floor.
 */
function readDeclaredBoardSize(state: unknown): number | null {
  if (!isPlainRecord(state)) {
    return null;
  }

  const declared: unknown = state.boardSize;

  if (
    typeof declared !== 'number' ||
    !Number.isSafeInteger(declared) ||
    declared < MINIMUM_PLAYABLE_BOARD_SIZE
  ) {
    return null;
  }

  return declared;
}

/**
 * Reads the largest value the run can spawn out of the live distribution,
 * skipping any entry that is not a positive finite number.
 *
 * @param values `config.spawn.values` exactly as the rules view carries it.
 * @returns The largest spawnable value, or `null` when the distribution
 *   offers none.
 */
function highestSpawnValue(values: readonly number[]): number | null {
  let highest = 0;

  for (const value of values) {
    if (Number.isFinite(value) && value > highest) {
      highest = value;
    }
  }

  return highest > 0 ? highest : null;
}

/**
 * Reads the ascension bank a state slot holds, normalising it into range.
 *
 * @param state The slot as it arrived, of any shape.
 * @returns The bank as a whole number from zero through the bank ceiling. An
 *   absent, non-numeric, non-finite or negative slot reads as zero.
 */
function readBank(state: unknown): number {
  if (typeof state !== 'number' || !Number.isFinite(state) || state <= 0) {
    return 0;
  }

  return Math.min(Math.floor(state), HOLLOW_ASCENSION_MAX_BANK);
}

/**
 * Orders two exiles for re-homing: highest face value first, and among equal
 * values the earlier of the x-outer, y-inner scan `occupiedCells` reports in.
 *
 * @param left First exile.
 * @param right Second exile.
 * @returns A negative number, zero, or a positive number.
 */
function byDescendingValue(
  left: { readonly value: number },
  right: { readonly value: number },
): number {
  return right.value - left.value;
}

/**
 * Collapses the live board by one edge once a stage is cleared.
 *
 * @param payload The stage result, read for `cleared`.
 * @param context The dispatch, read for `config.boardSize` and its effect
 *   queue and substreams.
 */
function collapsingVaultStageEnd(
  payload: StageEndPayload,
  context: HookContext,
): void {
  if (!payload.cleared) {
    return;
  }

  const current = context.config.boardSize;

  if (!Number.isSafeInteger(current)) {
    return;
  }

  const shrunk = Math.max(
    MINIMUM_PLAYABLE_BOARD_SIZE,
    current - BOARD_SHRINK_STEP,
  );

  // The floor, already reached: nothing is recorded and no draw is taken.
  if (shrunk >= current) {
    return;
  }

  const declared = readDeclaredBoardSize(context.state);
  const applied = declared === null ? shrunk : Math.min(declared, shrunk);
  const effects = context.effects;

  // Read once, before a single command is recorded.
  const occupied = effects.occupiedCells();
  const exiles = occupied
    .filter((cell) => cell.x >= applied || cell.y >= applied)
    .sort(byDescendingValue);
  const stream = context.rng.stream(RELIC_DRAW_STREAM);

  for (const exile of exiles) {
    const room = effects
      .availableCells()
      .filter((cell) => cell.x < applied && cell.y < applied);

    if (room.length === 0) {
      break;
    }

    const destination = stream.pick(room);

    if (destination === undefined) {
      break;
    }

    effects.moveTile({ x: exile.x, y: exile.y }, destination);
  }

  // The collapse. Every tile inside the new bound keeps the exact cell it
  // occupied and the survivors re-homed above keep the cells they were moved
  // to, so no position is reindexed or compacted; the command writes the size
  // into the rules with the lattice, so the loss probe, the win check and the
  // renderer's framing all follow the board that now exists.
  effects.resizeBoard(applied);

  // The resume path's copy of the same number.
  context.state = { boardSize: applied };
}

/**
 * Scales a merge's score contribution by the relic's multiplier.
 *
 * @param payload The merge, read for `scoreDelta`.
 * @returns The payload carrying the scaled contribution, or nothing when the
 *   arriving contribution is not a finite number.
 */
function gildedRotMerge(payload: MergePayload): MergePayload | void {
  if (!Number.isFinite(payload.scoreDelta)) {
    return;
  }

  const scoreDelta = Math.floor(
    payload.scoreDelta * GILDED_ROT_SCORE_MULTIPLIER,
  );

  if (!Number.isFinite(scoreDelta)) {
    return;
  }

  return { ...payload, scoreDelta };
}

/**
 * Raises a spawning tile to the largest value the run can spawn.
 *
 * @param payload The spawn, read for its cell.
 * @param context The dispatch, read for `config.spawn.values`.
 * @returns The payload carrying the raised value, or nothing.
 */
function gildedRotSpawn(
  payload: SpawnPayload,
  context: HookContext,
): SpawnPayload | void {
  const position = payload.position;

  if (position === undefined) {
    return;
  }

  const highest = highestSpawnValue(context.config.spawn.values);

  if (highest === null || highest === payload.value) {
    return;
  }

  return { position, value: highest };
}

/**
 * Reads the weights a state slot saved, as a fresh array.
 *
 * @param state The slot as it arrived, of any shape.
 * @returns A fresh copy of the saved weights, or `null` when the slot saved
 *   none usable — an absent slot, a slot of another shape, a non-array, an
 *   empty array, or any entry that is not a finite number at or above zero.
 */
function readSavedWeights(state: unknown): number[] | null {
  if (!isPlainRecord(state)) {
    return null;
  }

  const saved: unknown = state.savedWeights;

  if (!Array.isArray(saved) || saved.length === 0) {
    return null;
  }

  const weights: number[] = [];

  for (const weight of saved) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      return null;
    }

    weights.push(weight);
  }

  return weights;
}

/**
 * The skewed distribution the crown installs: the weight of the highest
 * configured spawn value multiplied by the skew factor, and every other weight
 * left as the rules declared it.
 *
 * @param values Spawn values in force, read for the highest of them.
 * @param weights Spawn weights in force, read and never written.
 * @returns A fresh weight array of the same length, or `null` where the two
 *   arrays cannot be read in lockstep or nothing could be drawn from the
 *   result.
 */
function skewedWeights(
  values: readonly number[],
  weights: readonly number[],
): number[] | null {
  if (values.length === 0 || values.length !== weights.length) {
    return null;
  }

  const highest = highestSpawnValue(values);

  if (highest === null) {
    return null;
  }

  const skewed: number[] = [];
  let total = 0;

  for (let index = 0; index < weights.length; index += 1) {
    const weight = weights[index];

    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      return null;
    }

    const raised =
      values[index] === highest
        ? weight * BRITTLE_CROWN_SPAWN_SKEW
        : weight;

    if (!Number.isFinite(raised)) {
      return null;
    }

    skewed.push(raised);
    total += raised;
  }

  return total > 0 ? skewed : null;
}

/**
 * Saves the spawn distribution in force and installs the skewed one.
 *
 * @param _payload The stage opening, read for nothing.
 * @param context The dispatch, read for the distribution in force and
 *   written for its state slot and its effect queue.
 */
function brittleCrownStageStart(
  _payload: StageStartPayload,
  context: HookContext,
): void {
  const spawn = context.config.spawn;
  const saved = readSavedWeights(context.state);
  const baseline = saved === null ? [...spawn.weights] : saved;
  const skewed = skewedWeights(spawn.values, baseline);

  if (skewed === null) {
    return;
  }

  context.state = { savedWeights: baseline };
  context.effects.setSpawnWeights(skewed);
}

/**
 * Restores the saved spawn distribution, pays the clearing bounty and releases
 * the slot.
 *
 * @param payload The stage result, read for `cleared` and `score`.
 * @param context The dispatch, whose slot is emptied and whose effect queue
 *   restores the distribution.
 */
function brittleCrownStageEnd(
  payload: StageEndPayload,
  context: HookContext,
): StageEndPayload | void {
  const saved = readSavedWeights(context.state);

  context.state = {};

  if (saved !== null) {
    context.effects.setSpawnWeights(saved);
  }

  if (!payload.cleared || !Number.isFinite(payload.score)) {
    return;
  }

  const bounty = Math.floor(payload.score * BRITTLE_CROWN_CLEAR_BOUNTY);

  if (bounty <= 0) {
    return;
  }

  const score = payload.score + bounty;

  if (!Number.isFinite(score)) {
    return;
  }

  return { ...payload, score };
}

/**
 * Pays out of the ascension bank and then banks one more charge.
 *
 * @param payload The merge, read for `scoreDelta`.
 * @param context The dispatch, read and written for its state slot.
 * @returns The payload carrying the sweetened contribution, or nothing.
 */
function hollowAscensionMerge(
  payload: MergePayload,
  context: HookContext,
): MergePayload | void {
  const bank = readBank(context.state);

  context.state = Math.min(
    bank + HOLLOW_ASCENSION_BANK_STEP,
    HOLLOW_ASCENSION_MAX_BANK,
  );

  if (!Number.isFinite(payload.scoreDelta)) {
    return;
  }

  const bonus = Math.floor(bank * HOLLOW_ASCENSION_BONUS_PER_BANK);

  if (bonus <= 0) {
    return;
  }

  const scoreDelta = payload.scoreDelta + bonus;

  if (!Number.isFinite(scoreDelta)) {
    return;
  }

  return { ...payload, scoreDelta };
}

/**
 * Empties the ascension bank when the stage was not cleared.
 *
 * @param payload The stage result, read for `cleared`.
 * @param context The dispatch, whose state slot is emptied on a failure.
 */
function hollowAscensionStageEnd(
  payload: StageEndPayload,
  context: HookContext,
): void {
  if (payload.cleared) {
    return;
  }

  context.state = 0;
}

const COLLAPSING_VAULT: Relic = Object.freeze<Relic>({
  id: 'collapsing-vault',
  name: 'Collapsing Vault',
  rarity: RARITIES[0],
  description:
    'Clearing a stage collapses the vault and the board loses an edge: ' +
    'tiles collide and merge sooner in the tighter space, and there is far ' +
    'less room left to recover from a bad turn.',
  hooks: Object.freeze({ onStageEnd: collapsingVaultStageEnd }),
  state: Object.freeze({}),
});

const GILDED_ROT: Relic = Object.freeze<Relic>({
  id: 'gilded-rot',
  name: 'Gilded Rot',
  rarity: RARITIES[1],
  description:
    'Every merge pays double, and every tile that spawns arrives at the ' +
    'largest value the run can spawn, so the board fills far faster.',
  hooks: Object.freeze({
    onMerge: gildedRotMerge,
    onSpawn: gildedRotSpawn,
  }),
});

const BRITTLE_CROWN: Relic = Object.freeze<Relic>({
  id: 'brittle-crown',
  name: 'Brittle Crown',
  rarity: RARITIES[2],
  description:
    'The crown demands more: while a stage runs, the largest tile value is ' +
    'four times as likely to spawn, and each stage you do clear pays a ' +
    'bounty of a quarter of the score.',
  hooks: Object.freeze({
    onStageStart: brittleCrownStageStart,
    onStageEnd: brittleCrownStageEnd,
  }),
  state: Object.freeze({}),
});

const HOLLOW_ASCENSION: Relic = Object.freeze<Relic>({
  id: 'hollow-ascension',
  name: 'Hollow Ascension',
  rarity: RARITIES[3],
  description:
    'Each merge banks ascension and every banked charge sweetens the merges ' +
    'that follow it, but failing to clear a stage empties the bank outright.',
  hooks: Object.freeze({
    onMerge: hollowAscensionMerge,
    onStageEnd: hollowAscensionStageEnd,
  }),
  state: 0,
});

/**
 * The `risk-reward-cursed` family.
 *
 * Named and frozen as the other three family modules are, so
 * src/relics/relic-registry.ts flattens all four through one uniform export
 * shape. Frozen at every level this module owns.
 */
export const RISK_REWARD_CURSED_FAMILY: RelicFamily = Object.freeze<RelicFamily>(
  {
    name: 'risk-reward-cursed',
    relics: Object.freeze([
      COLLAPSING_VAULT,
      GILDED_ROT,
      BRITTLE_CROWN,
      HOLLOW_ASCENSION,
    ]),
  },
);
