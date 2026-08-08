// The risk-reward-cursed relic family: four relics whose upside is paid for,
// and the family that holds the board-size-mutating relic.
//
// The family attaches at onStageStart, onStageEnd, onSpawn and onMerge, as each
// relic requires. Its hook points come from three places in the deleted
// controller: js/game_manager.js L156-L170, the merge branch, reached through
// onMerge; js/game_manager.js L69-L76, addRandomTile() and the spawn value
// literal at L71, reached through onSpawn; and js/game_manager.js L238-L268,
// movesAvailable()/tileMatchesAvailable(), which reads the board size a shrink
// changes. onStageEnd HAS NO VANILLA ANALOGUE.
//
// Brand new module: no source-branch file was ported into it. Relic
// declarations, module-level constants and pure helpers only — no registry, no
// draw, no dispatch.
//
// A handler here reaches the run through two channels and no others: the
// payload it returns, and its own `context.state` slot. It writes neither the
// lattice nor the rules — `HookContext.grid` is the frozen `ReadonlyGridView`
// and `HookContext.config` the frozen `ReadonlyRulesView`, and neither carries
// a write. `collapsing-vault` DECLARES the edge length it implies in its state
// slot. That slot is the value `reconcileBoardSize()` of
// src/run/run-state-store.ts reads as `relicBoardSize` and applies before any
// grid is constructed.
//
// This module reads no DOM, performs no I/O, consumes no randomness, reads no
// clock, reports nothing, holds no mutable module-level state and reads no
// `charges`.
//
// traceability rows of docs/TRACEABILITY_MATRIX.md, in declaration order:
//   TR-RISK-01  collapsing-vault   onStageEnd
//   TR-RISK-02  gilded-rot         onMerge, onSpawn
//   TR-RISK-03  brittle-crown      onStageStart, onStageEnd
//   TR-RISK-04  hollow-ascension   onMerge, onStageEnd

import type {
  HookContext,
  MergePayload,
  SpawnPayload,
  StageEndPayload,
  StageStartPayload,
} from '../../engine/hooks';
import type { Relic, RelicFamily } from '../relic-types';
import { RARITIES } from '../relic-types';

/* --------------------------------------------------------------------------
 * Relic magnitudes
 *
 * Each constant is one relic's own magnitude rather than a game rule: every
 * game rule this module acts on — the board edge length, the spawn values, the
 * stage goal and the score — is read from the live `HookContext` at use time.
 * ----------------------------------------------------------------------- */

/** Smallest edge length `collapsing-vault` will collapse a board to. */
const MINIMUM_PLAYABLE_BOARD_SIZE = 3;

/** Cells `collapsing-vault` takes off each edge per cleared stage. */
const BOARD_SHRINK_STEP = 1;

/** Factor `gilded-rot` scales a merge's score contribution by. */
const GILDED_ROT_SCORE_MULTIPLIER = 2;

/** Factor `brittle-crown` raises a stage goal's target by. */
const BRITTLE_CROWN_TARGET_SKEW = 1.5;

/** Ceiling `brittle-crown` clamps a raised target to. */
const BRITTLE_CROWN_MAX_GOAL_TARGET = 1e12;

/** Fraction of the score `brittle-crown` pays for a cleared stage. */
const BRITTLE_CROWN_CLEAR_BOUNTY = 0.25;

/** Score `hollow-ascension` adds per banked charge. */
const HOLLOW_ASCENSION_BONUS_PER_BANK = 4;

/** Charges `hollow-ascension` banks per merge. */
const HOLLOW_ASCENSION_BANK_STEP = 1;

/** Ceiling `hollow-ascension` clamps its bank to. */
const HOLLOW_ASCENSION_MAX_BANK = 4096;

/* --------------------------------------------------------------------------
 * Pure helpers
 * ----------------------------------------------------------------------- */

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
 * Reads the stage-goal target a state slot saved.
 *
 * @param state The slot as it arrived, of any shape.
 * @returns The saved target, or `null` when the slot holds none usable.
 */
function readSavedTarget(state: unknown): number | null {
  if (!isPlainRecord(state)) {
    return null;
  }

  const saved: unknown = state.savedTarget;

  if (typeof saved !== 'number' || !Number.isFinite(saved) || saved <= 0) {
    return null;
  }

  return saved;
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

/* --------------------------------------------------------------------------
 * collapsing-vault
 * ----------------------------------------------------------------------- */

/**
 * Declares the edge length the board collapses to once a stage is cleared.
 *
 * Reads `config.boardSize` from the live rules view at use time and writes the
 * next edge length into the relic's own state slot as `{ boardSize }`. That
 * slot is what `reconcileBoardSize()` of src/run/run-state-store.ts reads as
 * `relicBoardSize`; that function rebuilds the cell matrix at the applied size,
 * keeps every in-bounds tile in the exact cell it occupied, drops and counts
 * the rest, and leaves `grid.size` equal to the applied size.
 *
 * Writes no lattice, no `grid.size`, no `config.boardSize` and no
 * `config.winValue`.
 *
 * Changes nothing at all when the stage was not cleared, when the configured
 * edge length is not a usable integer, or when the board already stands at the
 * family's floor. The declared length never rises: a slot that already names a
 * smaller board keeps it.
 *
 * @param payload The stage result, read for `cleared`.
 * @param context The dispatch, read for `config.boardSize` and its state slot.
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

  // The floor, already reached: the slot is left exactly as it arrived.
  if (shrunk >= current) {
    return;
  }

  const declared = readDeclaredBoardSize(context.state);

  context.state = {
    boardSize: declared === null ? shrunk : Math.min(declared, shrunk),
  };
}

/* --------------------------------------------------------------------------
 * gilded-rot
 * ----------------------------------------------------------------------- */

/**
 * Scales a merge's score contribution by the relic's multiplier.
 *
 * Transforms `scoreDelta` alone and floors the product. `resultValue` is
 * carried across untouched, and `source` and `target` travel as the same
 * objects they arrived as.
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
 * Reads the ceiling out of `config.spawn.values` at use time. The cell is
 * carried across exactly as it arrived.
 *
 * Changes nothing when the payload carries no cell — the case
 * `SpawnPayload.position` is optional for, matching the full-board fall-through
 * of js/grid.js L37-L43 — when the distribution offers no positive value, or
 * when the arriving value is already the ceiling.
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

/* --------------------------------------------------------------------------
 * brittle-crown
 * ----------------------------------------------------------------------- */

/**
 * Raises the stage's goal target by the relic's skew factor.
 *
 * `goal` is the one transformable member of `onStageStart`, and src/engine/
 * engine.ts adopts the goal this dispatch resolves to for the whole stage.
 *
 * The target is saved into the state slot ONLY WHERE THE SLOT HOLDS NONE, and
 * the raised target is computed from the SAVED value rather than the arriving
 * one. A second dispatch within one stage — a restart, or a resume after a
 * reload, where the configuration and the goal both arrive fresh while the slot
 * survives in storage — therefore resolves to the target the first resolved to.
 * `brittleCrownStageEnd` clears the slot as the stage resolves.
 *
 * Changes nothing when the arriving target is not a positive finite number, or
 * when the raised target equals it.
 *
 * @param payload The stage opening, read for `goal.target`.
 * @param context The dispatch, read and written for its state slot.
 * @returns The payload carrying the raised goal, or nothing.
 */
function brittleCrownStageStart(
  payload: StageStartPayload,
  context: HookContext,
): StageStartPayload | void {
  const target = payload.goal.target;

  if (!Number.isFinite(target) || target <= 0) {
    return;
  }

  const saved = readSavedTarget(context.state);
  const savedTarget = saved === null ? target : saved;

  context.state = { savedTarget };

  const raised = Math.min(
    Math.ceil(savedTarget * BRITTLE_CROWN_TARGET_SKEW),
    BRITTLE_CROWN_MAX_GOAL_TARGET,
  );

  if (raised === target) {
    return;
  }

  return {
    ...payload,
    goal: { ...payload.goal, target: raised },
  };
}

/**
 * Pays the clearing bounty and releases the saved target.
 *
 * `score` is a transformable member of `onStageEnd` and src/engine/engine.ts
 * adopts the resolved value before it commits. The state slot is emptied on
 * every dispatch, cleared or not, which is the clear half of the save-only-if-
 * absent pair `brittleCrownStageStart` opens.
 *
 * Pays nothing when the stage was not cleared, when the arriving score is not
 * finite, when the bounty floors to zero or below, or when the paid score
 * would not be finite.
 *
 * @param payload The stage result, read for `cleared` and `score`.
 * @param context The dispatch, whose state slot is emptied.
 * @returns The payload carrying the paid score, or nothing.
 */
function brittleCrownStageEnd(
  payload: StageEndPayload,
  context: HookContext,
): StageEndPayload | void {
  context.state = {};

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

/* --------------------------------------------------------------------------
 * hollow-ascension
 * ----------------------------------------------------------------------- */

/**
 * Pays out of the ascension bank and then banks one more charge.
 *
 * The bonus is the bank as it stood when the merge began, scaled and floored,
 * and it is added to `scoreDelta`; `resultValue` is carried across untouched.
 * The bank is written on every dispatch, including one that pays nothing, and
 * is clamped to the bank ceiling.
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
 * A cleared stage leaves the bank exactly as it stands. This is the family's
 * use of `onStageEnd` as a carry-forward boundary; the hook has no vanilla
 * analogue.
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

/* --------------------------------------------------------------------------
 * Declarations
 *
 * Members of `Relic` only, one relic per ordinal position of `RARITIES`, and no
 * charge budget on any of the four. The charge guard and the charge decrement
 * both belong to src/engine/hook-bus.ts, and no handler above reads the field.
 * ----------------------------------------------------------------------- */

const COLLAPSING_VAULT: Relic = {
  id: 'collapsing-vault',
  name: 'Collapsing Vault',
  rarity: RARITIES[0],
  description:
    'Clearing a stage collapses the vault and the board loses an edge: ' +
    'tiles collide and merge sooner in the tighter space, and there is far ' +
    'less room left to recover from a bad turn.',
  hooks: { onStageEnd: collapsingVaultStageEnd },
  state: Object.freeze({}),
};

const GILDED_ROT: Relic = {
  id: 'gilded-rot',
  name: 'Gilded Rot',
  rarity: RARITIES[1],
  description:
    'Every merge pays double, and every tile that spawns arrives at the ' +
    'largest value the run can spawn, so the board fills far faster.',
  hooks: {
    onMerge: gildedRotMerge,
    onSpawn: gildedRotSpawn,
  },
};

const BRITTLE_CROWN: Relic = {
  id: 'brittle-crown',
  name: 'Brittle Crown',
  rarity: RARITIES[2],
  description:
    'The crown demands more: every stage goal is raised by half again, and ' +
    'each stage you do clear pays a bounty of a quarter of the score.',
  hooks: {
    onStageStart: brittleCrownStageStart,
    onStageEnd: brittleCrownStageEnd,
  },
  state: Object.freeze({}),
};

const HOLLOW_ASCENSION: Relic = {
  id: 'hollow-ascension',
  name: 'Hollow Ascension',
  rarity: RARITIES[3],
  description:
    'Each merge banks ascension and every banked charge sweetens the merges ' +
    'that follow it, but failing to clear a stage empties the bank outright.',
  hooks: {
    onMerge: hollowAscensionMerge,
    onStageEnd: hollowAscensionStageEnd,
  },
  state: 0,
};

/**
 * The `risk-reward-cursed` family.
 *
 * DECLARATION ORDER IS LOAD-BEARING. The array is flattened into the relic
 * catalogue in this order and the seeded reward draw resolves against that
 * catalogue: a reordering changes the offers a given seed produces and moves
 * the snapshot gate.
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
