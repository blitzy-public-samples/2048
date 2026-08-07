// The hook bus: pickup-order dispatch of the six engine hooks.
//
// Supersedes the three-name publish/subscribe bus of
// js/keyboard_input_manager.js L18-L32, whose `on()` appended a callback to
// the array keyed by event name and whose `emit()` invoked each callback
// inline with one argument, returning nothing. That append-and-invoke-inline
// shape is carried forward, with four properties added:
//
//   pickup order      every subscriber carries a pickup-order index and
//                     dispatch walks the subscribers bound to a hook in
//                     that index's order. The backing array is held in
//                     that order by insertion, so a dispatch neither
//                     copies nor sorts it; an edit arriving during a
//                     dispatch is deferred until the walk returns.
//   charge guard      a subscriber whose `charges` is present and not
//                     above zero is skipped before its handler is
//                     reached, and `consumeCharge` is the one path that
//                     deducts a charge.
//   error isolation   a handler that throws is caught, reported through
//                     the injected reporter and its subscriber marked
//                     degraded; the dispatch continues and returns the
//                     payload as it stood.
//   compounding       a handler receives the payload the handler before
//                     it returned, and a handler that returns nothing
//                     leaves that payload as it stands.
//   defensive records `register` copies the identifier and the handler
//                     table out of the subscriber and takes over its
//                     charge budget and state slot, and every object the
//                     bus hands back is a frozen snapshot, so the object
//                     a caller registered is never the object a dispatch
//                     reads.
//   payload validation a return is measured against the exact payload the
//                     hook declares — its member set, the identity of
//                     each live object it arrived with, and the range and
//                     finiteness of each number — and a return that is
//                     not that payload is discarded.
//   per-handler
//   transaction       each handler is handed a copy of the accumulated
//                     payload and reads its own state slot; the copy and
//                     the slot are adopted together once the handler has
//                     returned and its return has validated, and are
//                     discarded together when it throws.
//
// This module reads no DOM, performs no I/O, consumes no randomness, reads no
// clock, and is synchronous throughout. Nothing it hands a handler re-enters
// dispatch, and it branches on no subscriber identity.

import type {
  HookContext,
  HookEnvironment,
  HookHandler,
  HookHandlerTable,
  HookName,
  HookPayloadMap,
  HookSubscription,
  ReadonlyGridView,
  ReadonlyRngView,
  ReadonlyRulesView,
} from './hooks';
import { HOOK_NAMES } from './hooks';
import type {
  CorrelationId,
  EngineReporter,
  Position,
  SerializedGrid,
} from './types';
import {
  DIRECTION_DOWN,
  DIRECTION_LEFT,
  DIRECTION_RIGHT,
  DIRECTION_UP,
  NOOP_ENGINE_REPORTER,
} from './types';

/* --------------------------------------------------------------------------
 * Collaborator types, derived rather than imported
 * ----------------------------------------------------------------------- */

// The rules object, the board and the substream table are named through
// `HookEnvironment` and `ReadonlyRngView` instead of through their own
// modules, so this file's import surface stays ./hooks and ./types.

/** The rules in force, as `HookEnvironment` declares them. */
type EnvironmentRules = HookEnvironment['config'];

/** The live board, as `HookEnvironment` declares it. */
type EnvironmentGrid = HookEnvironment['grid'];

/** The run's substream table, as `HookEnvironment` declares it. */
type EnvironmentRng = HookEnvironment['rng'];

/** A substream name, as `ReadonlyRngView` declares it. */
type EnvironmentStreamName = Parameters<ReadonlyRngView['stream']>[0];

/** One substream, as `ReadonlyRngView` declares it. */
type EnvironmentStream = ReturnType<ReadonlyRngView['stream']>;

/** The total cursor map, as `ReadonlyRngView` declares it. */
type EnvironmentCursors = ReturnType<ReadonlyRngView['snapshotCursors']>;

const DISPATCH_METRIC = 'engine.hook.dispatch';

const HANDLER_METRIC = 'engine.hook.handler';

const EXHAUSTED_METRIC = 'engine.hook.exhausted';

const DEGRADED_METRIC = 'engine.hook.degraded';

const DETACHED_METRIC = 'engine.hook.detached';

const REJECTED_PAYLOAD_METRIC = 'engine.hook.payload.rejected';

const HANDLER_ERROR_METRIC = 'engine.hook.error';

const REGISTERED_METRIC = 'engine.hook.subscriber.registered';

const INVALID_SUBSCRIBER_METRIC = 'engine.hook.subscriber.invalid';

const REMOVED_METRIC = 'engine.hook.subscriber.removed';

const CHARGE_METRIC = 'engine.hook.charge.consumed';

/**
 * What is registered on the bus: the behavioural slice of the relic data
 * shape. The bus reads no member beyond these four.
 */
export interface HookSubscriber {
  /**
   * Identifier, carried into every report and into every dispatch context. A
   * second registration under an identifier already held is rejected.
   */
  readonly id: string;
  readonly hooks: HookHandlerTable;

  /**
   * Position in pickup order, which is the ordering authority of every
   * dispatch. Absent on a subscriber appended to the end of the order, which
   * is the default path: the bus then assigns an index above every index it
   * has assigned or been given. A value that is not a finite number is
   * treated as absent.
   */
  readonly pickupOrder?: number;

  /**
   * Charges remaining. Absent on a subscriber carrying no charge budget,
   * which is never charge-guarded; present and not above zero, every handler
   * of the subscriber is skipped. Written by `consumeCharge` and by nothing
   * else on the bus.
   */
  readonly charges?: number;

  /**
   * The subscriber's own state slot. Carried into each dispatch context and
   * written back from that context once the handler returns.
   */
  readonly state?: unknown;
}

export type HookSkipReason = 'exhausted' | 'degraded' | 'detached';

export interface HookDispatchResult<K extends HookName> {
  readonly payload: HookPayloadMap[K];
  readonly invoked: number;
  readonly skipped: number;
  readonly failed: number;
  readonly rejected: number;
}

/**
 * The outcome of one `consumeCharge` call.
 *
 * `held` and `limited` separate the three states a caller distinguishes
 * without consulting the subscriber: an identifier that is not registered
 * reports `held: false`; a registered subscriber carrying no charge budget
 * reports `limited: false`; and a charge-carrying subscriber reports both as
 * `true` with `remaining` present.
 */
export interface ChargeConsumption {
  readonly held: boolean;
  readonly limited: boolean;
  readonly consumed: number;

  /**
   * Charges the subscriber holds after the call: a whole number at or above
   * zero. Absent on an unregistered identifier and on a subscriber carrying
   * no charge budget.
   */
  readonly remaining?: number | undefined;
}

export interface HookHandlerCounters {
  readonly invoked: number;
  readonly skippedExhausted: number;
  readonly skippedDegraded: number;
  readonly skippedDetached: number;
  readonly rejected: number;
  readonly failed: number;
}

export interface HookCounters extends HookHandlerCounters {
  readonly dispatched: number;
}

export interface HookSubscriberMetrics extends HookHandlerCounters {
  readonly id: string;
  readonly pickupOrder: number;
  readonly registered: boolean;
  readonly degraded: boolean;
  readonly charges?: number | undefined;
  readonly chargesConsumed: number;
}

/**
 * Everything the bus counts. Read by the observability layer, which the engine
 * never imports.
 */
export interface HookBusMetrics {
  /**
   * Correlation identifier every report from this bus carries, injected
   * at construction. Read by src/observability/metrics.ts, which folds a
   * snapshot under this identifier so counts from one bus are never
   * attributed to another.
   */
  readonly correlationId: CorrelationId;

  /** Subscribers registered at the moment of the snapshot. */
  readonly registered: number;
  readonly acceptedRegistrations: number;
  readonly rejectedRegistrations: number;
  readonly removedSubscribers: number;
  readonly chargesConsumed: number;
  readonly reporterFaults: number;
  readonly lastReporterFault?: string | undefined;
  readonly degraded: readonly string[];
  readonly totals: HookCounters;
  readonly hooks: Readonly<Record<HookName, HookCounters>>;

  /**
   * Counts per subscriber, ordered by pickup order and then by registration
   * sequence. A subscriber's row outlives its registration, with `registered`
   * reporting `false` from then on.
   */
  readonly subscribers: readonly HookSubscriberMetrics[];
}

/* --------------------------------------------------------------------------
 * Bus
 * ----------------------------------------------------------------------- */

/**
 * The bus. Frozen: the eight members below are its whole surface, and it
 * exposes no way to reach itself from a handler.
 */
export interface HookBus {
  /**
   * Registers a subscriber. One carrying no `pickupOrder` is appended to the
   * end of pickup order, which is the default path; one carrying a finite
   * `pickupOrder` takes that position.
   *
   * @returns `true` when it was registered, `false` when its identifier is
   *   already held, is not a non-empty string, or its handler table binds no
   *   callable handler or binds a value that is not callable.
   */
  register(subscriber: HookSubscriber): boolean;

  /**
   * Removes a subscriber. Removing an identifier that is not held changes
   * nothing and reports `false`, so a repeated call is safe. A removal made
   * while a dispatch is walking takes effect within that walk: the
   * subscriber's remaining handlers are skipped.
   */
  unregister(id: string): boolean;

  /**
   * Dispatches one hook to every subscriber bound to it, in pickup order.
   *
   * @returns The accumulated payload and the dispatch's counts. Throws
   *   nothing that a handler or the reporter threw.
   */
  dispatch<K extends HookName>(
    hook: K,
    payload: HookPayloadMap[K],
    environment: HookEnvironment,
  ): HookDispatchResult<K>;

  /**
   * Deducts charges from one subscriber, and is the only path that writes
   * `charges`.
   *
   * Deducts at most the charges the subscriber holds, so the budget never
   * falls below zero and a call against a spent budget deducts nothing. A
   * stored budget that is not a whole number at or above zero is normalised
   * to ZERO as it is read, so an invalid budget is spent rather than
   * replenished.
   *
   * @param amount Charges to deduct. Rounded towards zero and clamped to
   *   zero from below; defaults to `1`.
   */
  consumeCharge(id: string, amount?: number): ChargeConsumption;

  /**
   * Reads the identifiers of the registrations marked degraded, in pickup
   * order. A registration is marked when one of its handlers throws and
   * stays marked for the rest of its registration; registering the
   * identifier again after removing it clears the mark.
   */
  degraded(): readonly string[];

  /**
   * Reads the subscriptions bound to one hook, in pickup order, including
   * those of a degraded registration, which `degraded()` reports separately.
   * The array is frozen and built fresh on each call, and its `charges` and
   * `state` members carry the subscriber's values as at the call.
   */
  subscriptions<K extends HookName>(
    hook: K,
  ): readonly HookSubscription<K>[];

  /**
   * Reads the registered subscribers in pickup order: a frozen array built
   * fresh on each call, whose elements are the registered objects
   * themselves.
   */
  subscribers(): readonly HookSubscriber[];

  /**
   * Reads everything the bus counts: a frozen snapshot built fresh on each
   * call.
   */
  metrics(): HookBusMetrics;
}

export interface HookBusOptions {
  /**
   * Correlation identifier of the run, carried into every report and
   * every dispatch context. Injected, never derived here: the one
   * authority is `deriveCorrelationId` in src/observability/logger.ts.
   * Defaults to the empty string.
   */
  readonly correlationId?: CorrelationId;

  /**
   * Sink for caught handler errors and counters. Defaults to
   * `NOOP_ENGINE_REPORTER`, so the bus is constructible with no argument.
   */
  readonly reporter?: EngineReporter;
}

type HandlerOutcome =
  | 'invoked'
  | 'skippedExhausted'
  | 'skippedDegraded'
  | 'skippedDetached'
  | 'rejected'
  | 'failed';

const OUTCOME_METRIC: Readonly<Record<HandlerOutcome, string>> =
  Object.freeze({
    invoked: HANDLER_METRIC,
    skippedExhausted: EXHAUSTED_METRIC,
    skippedDegraded: DEGRADED_METRIC,
    skippedDetached: DETACHED_METRIC,
    rejected: REJECTED_PAYLOAD_METRIC,
    failed: HANDLER_ERROR_METRIC,
  });

const SKIP_OUTCOME: Readonly<Record<HookSkipReason, HandlerOutcome>> =
  Object.freeze({
    exhausted: 'skippedExhausted',
    degraded: 'skippedDegraded',
    detached: 'skippedDetached',
  });

interface HandlerCounterRow {
  invoked: number;
  skippedExhausted: number;
  skippedDegraded: number;
  skippedDetached: number;
  rejected: number;
  failed: number;
}

interface HookCounterRow extends HandlerCounterRow {
  dispatched: number;
}

interface SubscriberCounterRow extends HandlerCounterRow {
  readonly id: string;
  readonly sequence: number;
  pickupOrder: number;
  chargesConsumed: number;
}

/**
 * A registration as the bus holds it. `pickupIndex` and `sequence` are fixed
 * at registration, so a subscriber's position and tie-break survive the
 * removal of an earlier one. `degraded` and `removed` are the two flags
 * dispatch reads.
 */
interface Registration {
  readonly id: string;
  readonly hooks: HookHandlerTable;
  readonly pickupIndex: number;
  readonly sequence: number;
  charges: number | undefined;
  state: unknown;
  degraded: boolean;
  removed: boolean;
}

function isHandler(value: unknown): boolean {
  return typeof value === 'function';
}

/**
 * Reports whether a handler table is usable: at least one of the six names of
 * `HOOK_NAMES` bound to a callable value, and none of them bound to a value
 * that is neither callable nor absent. A member under any other key is
 * neither required to be callable nor counted.
 */
function isUsableTable(hooks: unknown): boolean {
  if (typeof hooks !== 'object' || hooks === null) {
    return false;
  }

  const table = hooks as HookHandlerTable;
  let bound = 0;

  for (const name of HOOK_NAMES) {
    const value: unknown = table[name];

    if (value === undefined || value === null) {
      continue;
    }

    if (!isHandler(value)) {
      return false;
    }

    bound += 1;
  }

  return bound > 0;
}

/**
 * Reports whether a handler's return value is accepted as the payload the
 * next handler receives: a non-null object that is not an array.
 */
function copyHandlerTable(hooks: HookHandlerTable): HookHandlerTable {
  const copy: Record<string, unknown> = {};

  for (const name of HOOK_NAMES) {
    const handler: unknown = hooks[name];

    if (isHandler(handler)) {
      copy[name] = handler;
    }
  }

  return Object.freeze(copy) as HookHandlerTable;
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
 * @param value Value to test.
 * @returns `true` for a non-negative safe integer.
 */
function isNonNegativeInteger(value: unknown): boolean {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

/**
 * Reports whether a candidate payload carries exactly the named members
 * and no others.
 *
 * Extension with no vanilla source. Own enumerable keys are compared
 * against the declared set, so a member the payload type does not declare
 * refuses the return: a handler extends behaviour through its own `state`
 * slot, never by widening a payload the engine reads back.
 *
 * @param value Candidate payload.
 * @param required Members every payload of the hook carries.
 * @param optional Members a payload of the hook may carry.
 * @returns `true` when every required member is present and every present
 *   member is declared.
 */
function hasExactMembers(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  for (const name of required) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) {
      return false;
    }
  }

  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      return false;
    }
  }

  return true;
}

/**
 * Reports whether `value` is a cell coordinate inside the board.
 *
 * @param value Candidate position.
 * @param size Edge length of the live board.
 * @returns `true` for `{ x, y }` integers within `[0, size)`.
 */
function isCellPosition(value: unknown, size: number): boolean {
  if (!isRecord(value) || !hasExactMembers(value, ['x', 'y'])) {
    return false;
  }

  const x: unknown = value.x;
  const y: unknown = value.y;

  return (
    isNonNegativeInteger(x) &&
    isNonNegativeInteger(y) &&
    (x as number) < size &&
    (y as number) < size
  );
}

/**
 * Reports whether `value` is one of the four declared move directions.
 *
 * @param value Candidate direction.
 * @returns `true` for `DIRECTION_UP`, `DIRECTION_RIGHT`, `DIRECTION_DOWN`
 *   or `DIRECTION_LEFT`.
 */
function isDirection(value: unknown): boolean {
  return (
    value === DIRECTION_UP ||
    value === DIRECTION_RIGHT ||
    value === DIRECTION_DOWN ||
    value === DIRECTION_LEFT
  );
}

/**
 * Reports whether `value` is the stage goal shape the payload declares:
 * `{ kind, target }` with a string kind and a finite target.
 *
 * @param value Candidate goal.
 * @returns `true` for that shape.
 */
function isStageGoalShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactMembers(value, ['kind', 'target']) &&
    typeof value.kind === 'string' &&
    isFiniteNumber(value.target)
  );
}

/**
 * Validates a handler's return against the exact payload the hook
 * declares.
 *
 * Extension with no vanilla source, and the whole of it: a return the
 * engine reads back is measured member by member. Every member the type
 * declares must be present with the right kind and, where it is numeric,
 * finite and in range; nothing the type does not declare may be present;
 * and every member that arrived as a live object — the board on
 * `onBeforeMove` and `onAfterMove`, the two tiles on `onMerge` — must be
 * the same object it arrived as, so a handler transforms a payload's
 * values and never substitutes what the engine is holding.
 *
 * @param hook Hook being dispatched.
 * @param candidate Value the handler returned.
 * @param dispatched Payload the handler was given, read for the
 *   identities the return has to preserve.
 * @param environment The collaborators in force, read for the board.
 * @returns `true` when the candidate is that hook's payload exactly.
 */
function isValidPayload<K extends HookName>(
  hook: K,
  candidate: unknown,
  dispatched: HookPayloadMap[K],
  environment: HookEnvironment,
): boolean {
  if (!isRecord(candidate)) {
    return false;
  }

  const size = environment.grid.size;

  switch (hook) {
    case 'onStageStart': {
      const original = dispatched as HookPayloadMap['onStageStart'];

      return (
        hasExactMembers(candidate, [
          'stageIndex',
          'goal',
          'seed',
          'boardSize',
        ]) &&
        isNonNegativeInteger(candidate.stageIndex) &&
        isStageGoalShape(candidate.goal) &&
        typeof candidate.seed === 'string' &&
        candidate.seed === original.seed &&
        candidate.boardSize === size
      );
    }

    case 'onBeforeMove': {
      const original = dispatched as HookPayloadMap['onBeforeMove'];

      return (
        hasExactMembers(candidate, ['direction', 'board', 'cancelled']) &&
        isDirection(candidate.direction) &&
        candidate.board === original.board &&
        typeof candidate.cancelled === 'boolean'
      );
    }

    case 'onMerge': {
      const original = dispatched as HookPayloadMap['onMerge'];

      return (
        hasExactMembers(candidate, [
          'source',
          'target',
          'resultValue',
          'scoreDelta',
        ]) &&
        candidate.source === original.source &&
        candidate.target === original.target &&
        isFiniteNumber(candidate.resultValue) &&
        candidate.resultValue > 0 &&
        isFiniteNumber(candidate.scoreDelta)
      );
    }

    case 'onSpawn': {
      const position: unknown = candidate.position;

      return (
        hasExactMembers(candidate, ['value'], ['position']) &&
        (position === undefined || isCellPosition(position, size)) &&
        isFiniteNumber(candidate.value) &&
        candidate.value > 0
      );
    }

    case 'onAfterMove': {
      const original = dispatched as HookPayloadMap['onAfterMove'];

      return (
        hasExactMembers(candidate, [
          'moved',
          'board',
          'score',
          'over',
          'won',
          'terminated',
        ]) &&
        typeof candidate.moved === 'boolean' &&
        candidate.board === original.board &&
        isFiniteNumber(candidate.score) &&
        typeof candidate.over === 'boolean' &&
        typeof candidate.won === 'boolean' &&
        typeof candidate.terminated === 'boolean'
      );
    }

    case 'onStageEnd': {
      return (
        hasExactMembers(candidate, ['stageIndex', 'cleared', 'score']) &&
        isNonNegativeInteger(candidate.stageIndex) &&
        typeof candidate.cleared === 'boolean' &&
        isFiniteNumber(candidate.score)
      );
    }

    default: {
      const unhandled: never = hook;

      return unhandled;
    }
  }
}

/**
 * Copies one payload for one handler.
 *
 * Extension with no vanilla source. Shallow over the declared members, so
 * the live board and the two live tiles travel by reference exactly as
 * js/game_manager.js L91 passed the grid to the view, while the plain-data
 * members a handler might rewrite in place — `goal` and `position` — are
 * rebuilt. The handler therefore writes into a payload of its own, and the
 * bus decides whether that payload is adopted.
 *
 * @param hook Hook being dispatched.
 * @param payload Payload to copy.
 * @returns A fresh payload of the same hook.
 */
function copyPayload<K extends HookName>(
  hook: K,
  payload: HookPayloadMap[K],
): HookPayloadMap[K] {
  const copy: Record<string, unknown> = { ...(payload as object) };

  if (hook === 'onStageStart') {
    const goal = (payload as HookPayloadMap['onStageStart']).goal;

    copy.goal = { ...goal };
  }

  if (hook === 'onSpawn') {
    const position = (payload as HookPayloadMap['onSpawn']).position;

    if (position !== undefined) {
      copy.position = { x: position.x, y: position.y };
    }
  }

  return copy as unknown as HookPayloadMap[K];
}

/**
 * Reports whether a charge budget is spent.
 *
 * An absent budget is unlimited. A present budget is spent unless it is
 * a number above zero, which covers zero, negative and non-finite
 * values.
 *
 * @param charges Budget carried by the subscriber.
 * @returns `true` when the handler is to be skipped.
 */
function isChargeSpent(charges: number | undefined): boolean {
  return charges !== undefined && !(charges > 0);
}

/**
 * Normalises a charge count to a whole number at or above zero: rounded
 * towards zero, with anything below zero and anything not finite becoming
 * zero.
 */
function normaliseCharges(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
}

/**
 * Projects the rules in force to the frozen view a handler reads.
 *
 * Extension with no vanilla source. Built once per dispatch, so each
 * dispatch reads the rule values in force at that moment — `boardSize`
 * included, which is the value a board-mutating relic may have changed
 * during the run. The two merge members are the configured functions
 * themselves: calling one reads its operands and mutates neither.
 *
 * @param config Rules in force.
 * @returns The frozen view.
 */
function readonlyRulesView(config: EnvironmentRules): ReadonlyRulesView {
  return Object.freeze({
    boardSize: config.boardSize,
    winValue: config.winValue,
    startTiles: config.startTiles,
    spawn: Object.freeze({
      values: Object.freeze(config.spawn.values.slice()),
      weights: Object.freeze(config.spawn.weights.slice()),
    }),
    merge: Object.freeze({
      canMerge: config.merge.canMerge,
      produce: config.merge.produce,
    }),
  });
}

/**
 * Builds the frozen query facade a handler reads the board through.
 *
 * Extension with no vanilla source. Every method delegates to the live
 * board, so a read resolves against the board as it stands; `size` is a
 * getter for the same reason. `insertTile`, `removeTile`, the `cells`
 * matrix and the live `Tile` objects are absent, and `cellValue` returns a
 * face value where `Grid.cellContent` returns the tile itself.
 *
 * @param grid Live board.
 * @returns The frozen facade.
 */
function readonlyGridView(grid: EnvironmentGrid): ReadonlyGridView {
  const view: ReadonlyGridView = {
    get size(): number {
      return grid.size;
    },

    withinBounds: (position: Position): boolean => grid.withinBounds(position),

    cellAvailable: (cell: Position): boolean => grid.cellAvailable(cell),

    cellOccupied: (cell: Position): boolean => grid.cellOccupied(cell),

    cellValue: (cell: Position): number | null => {
      const tile = grid.cellContent(cell);

      return tile === null ? null : tile.value;
    },

    availableCells: (): Position[] => grid.availableCells(),

    cellsAvailable: (): boolean => grid.cellsAvailable(),

    serialize: (): SerializedGrid => grid.serialize(),
  };

  return Object.freeze(view);
}

/**
 * Builds the frozen draw facade a handler takes randomness through.
 *
 * Extension with no vanilla source. `stream` delegates to the run's
 * substream table, so a draw a handler takes advances the same cursor the
 * engine's draws advance and stays inside the run's seeded sequence; the
 * table itself cannot be replaced through the facade.
 *
 * @param rng The run's substreams.
 * @returns The frozen facade.
 */
function readonlyRngView(rng: EnvironmentRng): ReadonlyRngView {
  return Object.freeze({
    seed: rng.seed,
    stream: (name: EnvironmentStreamName): EnvironmentStream =>
      rng.stream(name),
    snapshotCursors: (): EnvironmentCursors => rng.snapshotCursors(),
  });
}

/**
 * Reads the pickup index a subscriber is registered at.
 *
 * @param requested Index the subscriber declared, where it declared one.
 * @param appended Index the bus assigns to an appended subscriber.
 * @returns `requested` when it is a finite number, and `appended`
 *   otherwise.
 */
function resolvePickupIndex(
  requested: number | undefined,
  appended: number,
): number {
  return requested !== undefined && Number.isFinite(requested)
    ? requested
    : appended;
}

/**
 * Orders two registrations by pickup index, then by registration sequence.
 * Both keys are finite numbers assigned by the bus and the sequence is
 * unique, so the order this produces is total.
 */
function byPickupOrder(left: Registration, right: Registration): number {
  return left.pickupIndex === right.pickupIndex
    ? left.sequence - right.sequence
    : left.pickupIndex - right.pickupIndex;
}

function bySubscriberOrder(
  left: SubscriberCounterRow,
  right: SubscriberCounterRow,
): number {
  return left.pickupOrder === right.pickupOrder
    ? left.sequence - right.sequence
    : left.pickupOrder - right.pickupOrder;
}

function createHookRow(): HookCounterRow {
  return {
    dispatched: 0,
    invoked: 0,
    skippedExhausted: 0,
    skippedDegraded: 0,
    skippedDetached: 0,
    rejected: 0,
    failed: 0,
  };
}

function createSubscriberRow(
  id: string,
  pickupOrder: number,
  sequence: number,
): SubscriberCounterRow {
  return {
    id,
    sequence,
    pickupOrder,
    chargesConsumed: 0,
    invoked: 0,
    skippedExhausted: 0,
    skippedDegraded: 0,
    skippedDetached: 0,
    rejected: 0,
    failed: 0,
  };
}

function freezeHookCounters(row: HookCounterRow): HookCounters {
  return Object.freeze({
    dispatched: row.dispatched,
    invoked: row.invoked,
    skippedExhausted: row.skippedExhausted,
    skippedDegraded: row.skippedDegraded,
    skippedDetached: row.skippedDetached,
    rejected: row.rejected,
    failed: row.failed,
  });
}

function freezeSubscriberMetrics(
  row: SubscriberCounterRow,
  registration: Registration | undefined,
): HookSubscriberMetrics {
  return Object.freeze({
    id: row.id,
    pickupOrder: row.pickupOrder,
    registered: registration !== undefined,
    degraded: registration !== undefined && registration.degraded,
    charges: registration?.charges,
    chargesConsumed: row.chargesConsumed,
    invoked: row.invoked,
    skippedExhausted: row.skippedExhausted,
    skippedDegraded: row.skippedDegraded,
    skippedDetached: row.skippedDetached,
    rejected: row.rejected,
    failed: row.failed,
  });
}

/** Text reported for a caught value that offered nothing readable. */
const UNREADABLE_THROWN = 'unreadable thrown value';

/**
 * Reads text from a caught value: its message where it is an `Error`, the
 * value itself where it is a string, its string form where it has one, and a
 * fixed placeholder otherwise.
 */
function describeError(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object' || typeof value === 'function') {
    if (value === null) {
      return 'null';
    }

    try {
      if ('message' in value) {
        const carried: unknown = Reflect.get(value, 'message');

        if (typeof carried === 'string' && carried.length > 0) {
          return carried;
        }
      }
    } catch {
      return UNREADABLE_THROWN;
    }

    return UNREADABLE_THROWN;
  }

  if (typeof value === 'symbol') {
    return UNREADABLE_THROWN;
  }

  try {
    return String(value);
  } catch {
    return UNREADABLE_THROWN;
  }
}

const UNHELD_CONSUMPTION: ChargeConsumption = Object.freeze({
  held: false,
  limited: false,
  consumed: 0,
});

const UNLIMITED_CONSUMPTION: ChargeConsumption = Object.freeze({
  held: true,
  limited: false,
  consumed: 0,
});

/**
 * Creates a frozen hook bus. Both options, and the argument itself, are
 * optional.
 */
export function createHookBus(options: HookBusOptions = {}): HookBus {
  const correlationId = options.correlationId ?? '';
  const reporter = options.reporter ?? NOOP_ENGINE_REPORTER;

  /**
   * Registrations held now, kept in pickup order by `byPickupOrder`.
   *
   * `register` inserts at the position that order gives rather than appending,
   * so every walk reads this array as it stands and no walk sorts.
   */
  const registrations: Registration[] = [];

  /**
   * How many dispatches are on the stack. Above zero, `register` and
   * `unregister` defer their edit to `pending` so a walk in progress sees a
   * stable array.
   */
  let dispatchDepth = 0;

  /** Edits deferred while a dispatch walks `registrations`. */
  const pending: (() => void)[] = [];

  /** Counter rows keyed by hook name, created on first use. */
  const hookRows = new Map<HookName, HookCounterRow>();

  /**
   * Counter rows keyed by subscriber identifier, created on first use and
   * kept after the subscriber is removed.
   */
  const subscriberRows = new Map<string, SubscriberCounterRow>();

  const totals = createHookRow();

  let nextPickupIndex = 0;

  let nextSequence = 0;

  let acceptedRegistrations = 0;

  let rejectedRegistrations = 0;

  let removedSubscribers = 0;

  let chargesConsumed = 0;

  let reporterFaults = 0;

  let lastReporterFault: string | undefined;

  /** Runs one report, containing a throw from the reporter itself. */
  const deliver = (report: () => void): void => {
    try {
      report();
    } catch (error: unknown) {
      reporterFaults += 1;
      lastReporterFault = describeError(error);
    }
  };

  const count = (metric: string, hook?: HookName, value = 1): void => {
    if (reporter.onCount === undefined) {
      return;
    }

    deliver((): void => {
      reporter.onCount?.({ correlationId, metric, value, hook });
    });
  };

  const hookRow = (hook: HookName): HookCounterRow => {
    const existing = hookRows.get(hook);

    if (existing !== undefined) {
      return existing;
    }

    const created = createHookRow();

    hookRows.set(hook, created);

    return created;
  };

  const subscriberRow = (
    id: string,
    pickupOrder = 0,
  ): SubscriberCounterRow => {
    const existing = subscriberRows.get(id);

    if (existing !== undefined) {
      return existing;
    }

    const created = createSubscriberRow(
      id,
      pickupOrder,
      subscriberRows.size,
    );

    subscriberRows.set(id, created);

    return created;
  };

  const note = (
    hook: HookName,
    id: string,
    outcome: HandlerOutcome,
  ): void => {
    hookRow(hook)[outcome] += 1;
    totals[outcome] += 1;
    subscriberRow(id)[outcome] += 1;
    count(OUTCOME_METRIC[outcome], hook);
  };

  const noteSkip = (
    hook: HookName,
    id: string,
    reason: HookSkipReason,
  ): void => {
    note(hook, id, SKIP_OUTCOME[reason]);
  };

  /**
   * Marks a registration degraded and hands the caught value to the reporter
   * exactly as it was thrown.
   */
  const noteThrow = (
    registration: Registration,
    hook: HookName,
    error: unknown,
  ): void => {
    registration.degraded = true;

    const id = registration.id;

    if (reporter.onHookError !== undefined) {
      deliver((): void => {
        reporter.onHookError?.({
          correlationId,
          hook,
          subscriberId: id,
          error,
        });
      });
    }

    note(hook, id, 'failed');
  };

  const findRegistration = (id: string): Registration | undefined =>
    registrations.find(
      // A record already marked removed is not held any more, even while its
      // array edit waits for the dispatch in progress to return, so the
      // identifier is free to be registered again at once.
      (registration): boolean => !registration.removed && registration.id === id,
    );

  /**
   * Reads the registrations still held, skipping any whose removal is
   * deferred behind a dispatch in progress.
   *
   * @returns A fresh array on each call, in pickup order.
   */
  const held = (): Registration[] =>
    registrations.filter((registration): boolean => !registration.removed);

  /**
   * Inserts one registration at the position pickup order gives it.
   *
   * @param registration Registration to hold.
   */
  const insertOrdered = (registration: Registration): void => {
    let index = registrations.length;

    while (
      index > 0 &&
      byPickupOrder(registrations[index - 1], registration) > 0
    ) {
      index -= 1;
    }

    registrations.splice(index, 0, registration);
  };

  /**
   * Applies an edit to `registrations` now, or defers it until the dispatch
   * walking the array returns.
   *
   * @param edit Edit to apply.
   */
  const applyOrDefer = (edit: () => void): void => {
    if (dispatchDepth > 0) {
      pending.push(edit);

      return;
    }

    edit();
  };

  /** Applies every deferred edit, oldest first. */
  const drainPending = (): void => {
    while (pending.length > 0) {
      const edit = pending.shift();

      edit?.();
    }
  };

  /**
   * Reads the registrations in pickup order.
   *
   * The array itself: `insertOrdered` keeps it in the order `byPickupOrder`
   * gives, and `applyOrDefer` keeps it stable for the length of a dispatch, so
   * neither a copy nor a sort is taken per walk. The pickup index remains the
   * ordering authority; the position a registration holds in the array is the
   * expression of it rather than a second source.
   *
   * @returns The live array, in pickup order.
   */
  const ordered = (): readonly Registration[] => registrations;

  const collectDegraded = (): string[] => {
    const ids: string[] = [];

    for (const registration of held()) {
      if (registration.degraded) {
        ids.push(registration.id);
      }
    }

    return ids;
  };

  /**
   * Builds the subscription a registration presents for one hook, or `null`
   * where the subscriber binds no callable handler for that hook. `charges`
   * and `state` are read from the subscriber at call time.
   */
  const subscriptionFor = <K extends HookName>(
    registration: Registration,
    hook: K,
  ): HookSubscription<K> | null => {
    const handler: unknown = registration.hooks[hook];

    if (!isHandler(handler)) {
      return null;
    }

    return Object.freeze({
      subscriberId: registration.id,
      pickupOrder: registration.pickupIndex,
      handler: handler as HookHandler<K>,
      charges: registration.charges,
      state: registration.state,
    });
  };

  /**
   * Builds the read-only snapshot of one registration `subscribers()`
   * returns.
   *
   * Extension with no vanilla source. Frozen, and carrying the bus's own
   * `charges` and `state` values as at the call, so a caller reads the
   * registration it made rather than reaching the object the bus
   * dispatches from.
   *
   * @param registration Registration to read.
   * @returns The frozen snapshot.
   */
  const snapshotOf = (registration: Registration): HookSubscriber =>
    Object.freeze({
      id: registration.id,
      hooks: registration.hooks,
      pickupOrder: registration.pickupIndex,
      charges: registration.charges,
      state: registration.state,
    });

  return Object.freeze({
    register(subscriber: HookSubscriber): boolean {
      const id: unknown = subscriber.id;

      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        findRegistration(id) !== undefined ||
        !isUsableTable(subscriber.hooks)
      ) {
        rejectedRegistrations += 1;
        count(INVALID_SUBSCRIBER_METRIC);

        return false;
      }

      const pickupIndex = resolvePickupIndex(
        subscriber.pickupOrder,
        nextPickupIndex,
      );

      // The record is built from the subscriber rather than holding it:
      // the identifier and the handler table are copied out and the table
      // is frozen, and the charge budget and the state slot are taken over
      // by the bus, so a later edit to the caller's object changes neither
      // what a dispatch invokes nor what a report names.
      const registration: Registration = {
        id,
        hooks: copyHandlerTable(subscriber.hooks),
        pickupIndex,
        sequence: nextSequence,
        charges: subscriber.charges,
        state: subscriber.state,
        degraded: false,
        removed: false,
      };

      // Inserted in pickup order, and deferred behind a dispatch in progress
      // so the walk sees a stable membership.
      applyOrDefer((): void => {
        insertOrdered(registration);
      });

      nextSequence += 1;
      nextPickupIndex = Math.max(nextPickupIndex, pickupIndex) + 1;
      acceptedRegistrations += 1;

      subscriberRow(id, pickupIndex).pickupOrder = pickupIndex;
      count(REGISTERED_METRIC);

      return true;
    },

    unregister(id: string): boolean {
      // Extension with no vanilla source.
      const registration = findRegistration(id);

      if (registration === undefined) {
        return false;
      }

      // Marked immediately, so a dispatch already walking the array skips the
      // subscriber as detached on this dispatch; the array edit itself waits
      // until that walk returns.
      registration.removed = true;

      applyOrDefer((): void => {
        const index = registrations.indexOf(registration);

        if (index >= 0) {
          registrations.splice(index, 1);
        }
      });

      removedSubscribers += 1;
      count(REMOVED_METRIC);

      return true;
    },

    dispatch<K extends HookName>(
      hook: K,
      payload: HookPayloadMap[K],
      environment: HookEnvironment,
    ): HookDispatchResult<K> {
      hookRow(hook).dispatched += 1;
      totals.dispatched += 1;
      count(DISPATCH_METRIC, hook);

      // The payload as the last handler that returned and validated left
      // it. A handler that throws, or returns something that is not this
      // hook's payload, leaves it where it stood.
      let accumulated = payload;
      let invoked = 0;
      let skipped = 0;
      let failed = 0;
      let rejected = 0;

      // The three collaborators are projected once per dispatch and frozen,
      // so each handler of one dispatch reads the same values and none can
      // write through them.
      const rules = readonlyRulesView(environment.config);
      const board = readonlyGridView(environment.grid);
      const draws = readonlyRngView(environment.rng);

      // Order and membership are read once, ahead of the walk. A
      // registration added during the walk is reached by the next dispatch;
      // one removed during it is skipped by this one.
      const walking = ordered();

      dispatchDepth += 1;

      try {
        for (const registration of walking) {
          const subscription = subscriptionFor(registration, hook);

          if (subscription === null) {
            continue;
          }

          const id = subscription.subscriberId;

          if (registration.removed) {
            skipped += 1;
            noteSkip(hook, id, 'detached');

            continue;
          }

          if (registration.degraded) {
            skipped += 1;
            noteSkip(hook, id, 'degraded');

            continue;
          }

          const charges = subscription.charges;

          // The charge guard.
          if (isChargeSpent(charges)) {
            skipped += 1;
            noteSkip(hook, id, 'exhausted');

            continue;
          }

          const context: HookContext = {
            config: rules,
            rng: draws,
            grid: board,
            correlationId,
            hook,
            subscriberId: id,
            pickupOrder: subscription.pickupOrder,
            charges,
            state: registration.state,
          };

          // The handler writes into a payload of its own. An in-place
          // assignment therefore reaches this copy and not the payload the
          // caller passed or the one the handler before it produced.
          const working = copyPayload(hook, accumulated);

          invoked += 1;
          note(hook, id, 'invoked');

          try {
            const returned: unknown = subscription.handler(working, context);
            const candidate: unknown =
              returned === undefined || returned === null ? working : returned;

            if (isValidPayload(hook, candidate, accumulated, environment)) {
              accumulated = candidate as HookPayloadMap[K];

              // The state slot is committed with the payload, so a handler's
              // carried-over state and the effect it produced are adopted
              // together or not at all.
              registration.state = context.state;
            } else {
              rejected += 1;
              note(hook, id, 'rejected');
            }
          } catch (error: unknown) {
            // Nothing the handler wrote is kept: `accumulated` still holds
            // the payload it was handed a copy of, and `registration.state`
            // still holds the slot it entered with.
            failed += 1;
            noteThrow(registration, hook, error);
          }
        }
      } finally {
        dispatchDepth -= 1;

        // The edits a handler made to the registration array were deferred
        // for the length of the walk; they are applied here, oldest first.
        if (dispatchDepth === 0) {
          drainPending();
        }
      }

      return Object.freeze({
        payload: accumulated,
        invoked,
        skipped,
        failed,
        rejected,
      });
    },

    consumeCharge(id: string, amount = 1): ChargeConsumption {
      const registration = findRegistration(id);

      if (registration === undefined) {
        return UNHELD_CONSUMPTION;
      }

      if (registration.charges === undefined) {
        return UNLIMITED_CONSUMPTION;
      }

      const available = normaliseCharges(registration.charges);
      const taken = Math.min(available, normaliseCharges(amount));
      const remaining = available - taken;

      registration.charges = remaining;

      if (taken > 0) {
        chargesConsumed += taken;
        subscriberRow(id, registration.pickupIndex).chargesConsumed +=
          taken;
        count(CHARGE_METRIC, undefined, taken);
      }

      return Object.freeze({
        held: true,
        limited: true,
        consumed: taken,
        remaining,
      });
    },

    degraded(): readonly string[] {
      return Object.freeze(collectDegraded());
    },

    subscriptions<K extends HookName>(
      hook: K,
    ): readonly HookSubscription<K>[] {
      const resolved: HookSubscription<K>[] = [];

      for (const registration of held()) {
        const subscription = subscriptionFor(registration, hook);

        if (subscription !== null) {
          resolved.push(subscription);
        }
      }

      return Object.freeze(resolved);
    },

    subscribers(): readonly HookSubscriber[] {
      // Extension with no vanilla source. Each element is a frozen
      // snapshot built by `snapshotOf`, never the object the caller
      // registered.
      return Object.freeze(ordered().map(snapshotOf));
    },

    metrics(): HookBusMetrics {
      const hooks = {} as Record<HookName, HookCounters>;

      for (const name of HOOK_NAMES) {
        hooks[name] = freezeHookCounters(hookRow(name));
      }

      const rows = Array.from(subscriberRows.values()).sort(
        bySubscriberOrder,
      );

      const perSubscriber = rows.map(
        (row): HookSubscriberMetrics =>
          freezeSubscriberMetrics(row, findRegistration(row.id)),
      );

      return Object.freeze({
        correlationId,
        registered: registrations.length,
        acceptedRegistrations,
        rejectedRegistrations,
        removedSubscribers,
        chargesConsumed,
        reporterFaults,
        lastReporterFault,
        degraded: Object.freeze(collectDegraded()),
        totals: freezeHookCounters(totals),
        hooks: Object.freeze(hooks),
        subscribers: Object.freeze(perSubscriber),
      });
    },
  });
}
