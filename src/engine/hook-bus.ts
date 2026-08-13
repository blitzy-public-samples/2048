// The hook bus: pickup-order dispatch of the six engine hooks.
//
// This module reads no DOM, performs no I/O, consumes no randomness of its
// own, reads no clock, and is synchronous throughout. Nothing it hands a
// handler re-enters dispatch, and it branches on no subscriber identity.
//
// That superseded bus is row TR-HOOKBUS-01 of
// docs/TRACEABILITY_MATRIX.md, and the four properties added to it are one
// row each:
//   TR-HOOKBUS-01  js/keyboard_input_manager.js L18-L32
//                                the append-only `on` and the synchronous
//                                in-order `emit` this bus supersedes
//   TR-HOOKBUS-02  target-only row  pickup-order dispatch
//   TR-HOOKBUS-03  target-only row  the charge guard, applied before a
//                                   handler is reached
//   TR-HOOKBUS-04  target-only row  per-subscriber error isolation
//   TR-HOOKBUS-05  target-only row  the compounding payload protocol
// The four are described in the order below:
//
//   pickup order      every subscriber carries a pickup-order index and
//                     dispatch walks the subscribers bound to a hook in
//                     that index's order. The backing array is held in
//                     that order by insertion, so a dispatch neither
//                     copies nor sorts it; an edit arriving during a
//                     dispatch is deferred until the walk returns.
//   charge guard      a subscriber whose `charges` is present and not
//                     above zero is skipped before its handler is
//                     reached, on EVERY ONE of the six hooks: no hook is
//                     exempt, so an exhausted relic runs no handler at
//                     all. One deduction rule inside
//                     this module is the only thing that writes a budget. It is
//                     reached from `consumeCharge`, which a collaborator
//                     calls, and from the per-handler commit below, which
//                     spends what a handler asked for through
//                     `HookContext.spendCharge` once its return has been
//                     accepted. A handler never reads, compares or writes
//                     a budget, and a dispatch that asked for nothing
//                     spends nothing.
//   error isolation   a handler that throws is caught, reported through
//                     the injected reporter and its subscriber marked
//                     degraded; the dispatch continues and returns the
//                     payload as it stood.
//   compounding       a handler receives the payload the handler before
//                     it returned, and a handler that returns nothing
//                     leaves that payload as it stands.
//   defensive records `register` copies the identifier and the handler
//                     table out of the subscriber, takes over its charge
//                     budget, and copies its state slot all the way down,
//                     and every object the bus hands back is a frozen
//                     snapshot carrying a copy of that slot, so the object
//                     a caller registered is never the object a dispatch
//                     reads.
//   payload validation a return is measured against the exact payload the
//                     hook declares — its member set, the identity of
//                     each live object it arrived with, and the range and
//                     finiteness of each number — and a return that is
//                     not that payload is discarded.
//   per-handler
//   transaction       each handler is handed a copy of the accumulated
//                     payload, a full copy of its own state slot, and a
//                     fork of every substream it draws from. The three
//                     are adopted together once the handler has returned
//                     and its return has validated, and are discarded
//                     together when it throws or its return is refused.
//
// WHAT A THROWING HANDLER LEAVES BEHIND: NOTHING. That claim is enforced
// rather than asserted, at four crossings, because each was a way for a failed
// handler to change a run:
//
//   the payload      `copyPayload` gives the handler its own object, so an
//                    in-place write reaches that copy alone.
//   the state slot   `copyState` copies the slot at registration, into the
//                    context, and back out again, so a write at ANY DEPTH
//                    reaches a copy. A slot taken over by reference — as it
//                    was — left nested writes behind even though the
//                    reassignment was rolled back.
//   the charge       a spend is REQUESTED during the handler and deducted
//                    only after its return validates, so a handler that
//                    asked and then threw, or whose return was refused,
//                    leaves the budget where it stood.
//   the board and
//   its tiles        the board reaches a handler as a query-only facade, and
//                    the two merging tiles of `onMerge` reach it as frozen
//                    projections built by src/engine/move-resolver.ts, so
//                    neither the lattice nor a `Tile` is ever in a handler's
//                    hands.
//   randomness       `openRngTransaction` hands the handler forks and
//                    advances the run's substreams only on commit, so a
//                    handler that draws and then throws consumes nothing and
//                    perturbs no later spawn.
//
// This module reads no DOM, performs no I/O, consumes no randomness of its own,
// reads no clock, and is synchronous throughout. Nothing it hands a handler
// re-enters dispatch, and it branches on no subscriber identity.
//
// THE SHARED CHANNEL. Besides dispatching the six hooks to relics, this bus
// carries the seven engine events to every non-relic peer — the renderer, the
// screen flow and the observability layer — through `events` and
// `attachEvents`. The engine emits; `attachEvents` relays; peers subscribe to
// `events`. Relics and peers therefore share ONE bus, which is the topology
// AAP Figure 2 and Figure 3 declare. A payload crosses the relay by reference
// and unwrapped, so a peer receives the object the engine emitted.
//
// Decisions behind this file: DL-HOOKBUS-01, the charge guard living in
// the bus; DL-HOOKBUS-02, the pickup-order index deciding dispatch order;
// DL-HOOKBUS-03, the compounding return protocol in which a handler that
// returns nothing leaves the payload as it stands; DL-HOOKBUS-04, the
// per-subscriber error isolation that marks a throwing registration degraded
// and completes the dispatch; DL-HOOKBUS-05, the payload validation a return is
// measured against; DL-HOOKBUS-06, the engine-event relay above; and
// DL-HOOKBUS-07, the charge guard applying to all six hooks with none exempt.

import type {
  HookContext,
  HookDispatchPayloadMap,
  HookEnvironment,
  HookHandler,
  HookHandlerTable,
  HookName,
  HookPayloadMap,
  HookSubscription,
  ReadonlyGridView,
  ReadonlyRngView,
  ReadonlyRulesView,
  ReadonlyTileView,
} from './hooks';
import { HOOK_NAMES } from './hooks';

// ADDED: the goal kinds as data, so the validator below measures a returned
// `goal.kind` against the declared set rather than against `typeof`.
// DL-HOOKBUS-08.
import { isStageGoalKind } from '../config/stage-config';
import type {
  EngineEventPayloadMap,
  EngineEventSubscription,
  EngineEvents,
} from './engine-events';
import { ENGINE_EVENT_NAMES, createEngineEvents } from './engine-events';
import type { BoardEffect, BoardEffectTransaction } from './board-effects';
import { INERT_BOARD_EFFECTS, openBoardEffects } from './board-effects';
import type {
  CorrelationId,
  CorrelationSource,
  EngineListenerErrorReport,
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
  correlationReader,
} from './types';


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
 * Counter name for one injected tracing wrapper that failed and was contained.
 */
const TRACING_FAULT_METRIC = 'engine.hook.tracing.fault';

/** Board and rules commands written after a handler's return was adopted. */
const EFFECT_APPLIED_METRIC = 'engine.hook.effect.applied';

/** Board and rules commands dropped with a refused or failed handler. */
const EFFECT_DROPPED_METRIC = 'engine.hook.effect.dropped';

/** Listeners registered by one `attachEvents` call, counted once per call. */
const RELAY_ATTACHED_METRIC = 'engine.hook.events.attached';

/** An `attachEvents` call naming an emitter this bus already relays. */
const RELAY_REATTACHED_METRIC = 'engine.hook.events.reattached';

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
   * has assigned or been given.
   */
  readonly pickupOrder?: number;

  /**
   * Charges remaining. Absent on a subscriber carrying no charge budget, which
   * is never charge-guarded; present and not above zero, every handler of the
   * subscriber is skipped.
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

  /**
   * Charges this dispatch spent, across every handler it invoked.
   *
   * A budget-carrying handler pays what it asked for through
   * `HookContext.spendCharge`, and one charge where it asked for nothing but
   * had a board command accepted. Zero for a dispatch that changed nothing.
   */
  readonly chargesConsumed: number;

  /**
   * Board and rules commands this dispatch wrote, across every handler whose
   * return was accepted.
   *
   * Reported so a CALLER can tell a dispatch that reseated the board from one
   * that only read it — the withdrawn-move-plus-undo pairing being the case
   * that needs it — without reaching for the lattice itself.
   */
  readonly effectsApplied: number;

  /**
   * The commands this dispatch wrote, in the order they were written.
   *
   * The count above answers "did anything change"; this answers "what".
   * Carried so the engine can account for the write it does not itself make —
   * the score a restore reinstates, and the reconciliation a resize forces on
   * the win and loss checks — without inspecting the lattice for a difference.
   */
  readonly effects: readonly BoardEffect[];

  /** Commands this dispatch REFUSED, across every handler it invoked. */
  readonly effectsRefused: number;
}

/** The outcome of one `consumeCharge` call. */
export interface ChargeConsumption {
  readonly held: boolean;
  readonly limited: boolean;
  readonly consumed: number;

  /**
   * Charges the subscriber holds after the call: a whole number at or above
   * zero. Absent on an unregistered identifier and on a subscriber carrying no
   * charge budget.
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
   * Correlation identifier every report from this bus carries, as it stands
   * when the snapshot is taken. Read by src/observability/metrics.ts, which
   * folds a snapshot under this identifier so counts from one bus are never
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

/**
 * The bus. Frozen: the ten members below are its whole surface, and it
 * exposes no way to reach itself from a handler.
 */
export interface HookBus {
  /**
   * The shared event channel every NON-RELIC peer subscribes to: the renderer,
   * the screen flow and the observability layer.
   *
   * Carries the seven engine events under their own names and payloads, each
   * relayed from the emitter `attachEvents` was given, BY REFERENCE and
   * unwrapped. A payload a peer receives here is the object the engine emitted.
   *
   * Emits nothing of its own: an event reaches this channel only because a
   * relayed source emitted it. A peer that throws is contained, reported
   * through the injected reporter's listener channel, and the remaining peers
   * still receive the event. DL-HOOKBUS-06.
   */
  readonly events: EngineEvents;

  /**
   * Relays one emitter's seven events onto `events`, which is what makes this
   * bus the one channel relics and peers share.
   *
   * Registers one listener per name in `ENGINE_EVENT_NAMES` on `source`, in
   * that order, and re-emits each payload unchanged. Because those listeners
   * are appended in one call, a peer's position relative to a listener
   * registered DIRECTLY on `source` is decided by when this call was made.
   *
   * @param source Emitter to relay. The engine's own, in the composed app.
   * @returns A handle removing every listener this call registered. Calling it
   *   more than once removes nothing further.
   */
  attachEvents(source: EngineEvents): EngineEventSubscription;

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
   * nothing and reports `false`, so a repeated call is safe.
   */
  unregister(id: string): boolean;

  /**
   * Dispatches one hook to every subscriber bound to it, in pickup order.
   *
   * @param payload The dispatch-input payload, carrying the live `Grid` on
   *   `onBeforeMove` and `onAfterMove` and the two live `Tile`s on `onMerge`.
   *   Handlers never see those objects: the bus substitutes the frozen
   *   capability views of `HookPayloadMap` for them before the first handler
   *   is invoked, so a handler that throws cannot leave the board or a tile
   *   mutated behind it.
   * @returns The accumulated payload — carrying the views, not the live
   *   objects — and the dispatch's counts. Throws nothing that a handler or
   *   the reporter threw.
   */
  dispatch<K extends HookName>(
    hook: K,
    payload: HookDispatchPayloadMap[K],
    environment: HookEnvironment,
  ): HookDispatchResult<K>;

  /**
   * Deducts charges from one subscriber: the path a COLLABORATOR spends a
   * budget through, and one of the two callers of the module's single
   * deduction rule — the other being the per-handler commit, which spends what
   * a handler requested through `HookContext.spendCharge`.
   *
   * @param amount Charges to deduct. Rounded towards zero and clamped to
   *   zero from below; defaults to `1`.
   */
  consumeCharge(id: string, amount?: number): ChargeConsumption;

  /**
   * Reads the identifiers of the registrations marked degraded, in pickup
   * order. A registration is marked when one of its handlers throws and stays
   * marked for the rest of its registration; registering the identifier again
   * after removing it clears the mark.
   */
  degraded(): readonly string[];

  /**
   * Reads the subscriptions bound to one hook, in pickup order, including
   * those of a degraded registration, which `degraded` reports separately. The
   * array is frozen and built fresh on each call, and its `charges` and
   * `state` members carry the subscriber's values as at the call.
   */
  subscriptions<K extends HookName>(
    hook: K,
  ): readonly HookSubscription<K>[];

  /**
   * Reads the registered subscribers in pickup order: a frozen array built
   * fresh on each call, whose elements are the registered objects themselves.
   */
  subscribers(): readonly HookSubscriber[];

  /**
   * Reads everything the bus counts: a frozen snapshot built fresh on each
   * call.
   */
  metrics(): HookBusMetrics;
}

/**
 * The two wrappers a caller may inject to measure this bus's boundaries: one
 * per dispatch, and one per handler invocation inside it.
 */
export interface HookDispatchTracing {
  /** Wraps one whole dispatch of one hook. */
  readonly traceHookDispatch?: <T>(hook: HookName, run: () => T) => T;

  /** Wraps one subscriber's handler within a dispatch. */
  readonly traceRelicHandler?: <T>(
    hook: HookName,
    relicId: string,
    run: () => T,
  ) => T;
}

/** The name src/engine's own suites use for `HookDispatchTracing`. */
export type HookBusTracing = HookDispatchTracing;

export interface HookBusOptions {
  /**
   * Correlation identifier of the run, carried into every report and every
   * dispatch context. Injected, never derived here: the one authority is
   * `deriveCorrelationId` in src/observability/logger.ts.
   */
  readonly correlationId?: CorrelationSource;

  /**
   * Sink for caught handler errors and counters. Defaults to
   * `NOOP_ENGINE_REPORTER`, so the bus is constructible with no argument.
   */
  readonly reporter?: EngineReporter;

  /**
   * Spans the dispatch and each handler are run inside. Absent by default, in
   * which case the bus runs them directly, traces nothing and behaves exactly
   * as it does uninstrumented — which is what keeps this module free of any
   * observability dependency.
   */
  readonly tracing?: HookDispatchTracing;
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
 * removal of an earlier one.
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

/** Nesting depth a state slot is copied to. */
const MAX_STATE_DEPTH = 8;

/** Members one level of a state slot will carry. */
const MAX_STATE_MEMBERS = 256;

/**
 * Copies one state slot, all the way down.
 *
 * THE STATE-OWNERSHIP BOUNDARY. A slot is JSON data — the run envelope
 * persists it — so a copy of it is a copy in full, and the bus holds a slot no
 * caller and no handler shares an object with. Copying at EVERY crossing —
 * registration and each hand-off to a context — is what makes a rollback total:
 * a reference held across one of them would let a handler's write into a nested
 * member survive a throw the reassignment was rolled back for. Decision
 * DL-HOOKBUS-04.
 *
 * A value JSON cannot carry — a function, a symbol, `undefined` inside an
 * object — is dropped exactly as `JSON.stringify` would drop it, so a slot
 * that survives a copy is a slot that survives persistence. `NaN` and the
 * infinities are kept as they are, because the slot is not serialised here.
 *
 * @param value Slot to copy.
 * @param depth Levels already descended.
 * @returns A copy sharing no object with `value`.
 */
function copyState(value: unknown, depth = 0): unknown {
  if (value === null) {
    return null;
  }

  const kind = typeof value;

  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    return value;
  }

  if (kind !== 'object') {
    // A function, a symbol, `undefined` and a bigint are all values JSON
    // cannot carry, so none of them can be a persisted state slot.
    return undefined;
  }

  if (depth >= MAX_STATE_DEPTH) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const copied: unknown[] = [];
    const length = Math.min(value.length, MAX_STATE_MEMBERS);

    for (let index = 0; index < length; index += 1) {
      // JSON writes `null` for an entry it cannot carry, and so does this.
      copied.push(copyState(value[index], depth + 1) ?? null);
    }

    return copied;
  }

  const copied: Record<string, unknown> = {};
  let kept = 0;

  for (const [name, member] of Object.entries(value as object)) {
    if (kept >= MAX_STATE_MEMBERS) {
      break;
    }

    const copiedMember = copyState(member, depth + 1);

    if (copiedMember !== undefined) {
      copied[name] = copiedMember;
      kept += 1;
    }
  }

  return copied;
}

/**
 * Reports whether a handler table is usable: at least one of the six names of
 * `HOOK_NAMES` bound to a callable value, and none of them bound to a value
 * that is neither callable nor absent.
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
 * Reports whether a handler's return value is accepted as the payload the next
 * handler receives: a non-null object that is not an array.
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
 * Reports whether `value` is a plain object: an object that is neither `null`
 * nor an array.
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
 * Reports whether a candidate payload carries exactly the named members and no
 * others.
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
 * @returns `true` for `DIRECTION_UP`, `DIRECTION_RIGHT`, `DIRECTION_DOWN` or
 *   `DIRECTION_LEFT`.
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
 * Reports whether `value` is the stage goal shape the payload declares.
 *
 * @param value Candidate goal.
 * @returns `true` for that shape.
 */
function isStageGoalShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactMembers(value, ['kind', 'target']) &&
    // CHANGED: measured against the declared kinds rather than `typeof value.kind
    // === 'string'`. The engine ADOPTS the goal this payload resolves to, and
    // `evaluateStageGoal` raises on a kind it cannot narrow, so a handler that
    // returned `{ kind: 'anything', target: 8 }` was admitted here and threw
    // later, on a stage that had already started. DL-HOOKBUS-08.
    isStageGoalKind(value.kind) &&
    isFiniteNumber(value.target)
  );
}

/**
 * Validates a handler's return against the exact payload the hook declares.
 *
 * @param hook Hook being dispatched.
 * @param candidate Value the handler returned.
 * @param dispatched Payload the handler was given, read for the identities
 *   the return has to preserve.
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
        // INVARIANT, exactly as src/engine/hooks.ts declares it: `goal` alone is
        // transformable. CHANGED: the index is now pinned to the dispatched one,
        // where any non-negative integer used to be admitted — so a handler
        // could renumber the stage the engine had opened, and the stage it
        // reported starting was not the stage it was on. DL-HOOKBUS-09.
        candidate.stageIndex === original.stageIndex &&
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
      const count: unknown = candidate.count;

      // Shape and bounds, not vacancy. The board effects recorded during this
      // same dispatch are applied after the return is adopted, so a cell that
      // is empty while this runs can be occupied by the time the spawn
      // inserts: occupancy is therefore tested at the insertion boundary in
      // src/engine/engine.ts, which is the last point before the write, and an
      // occupied cell suppresses the spawn there.
      return (
        hasExactMembers(candidate, ['value'], ['position', 'count']) &&
        (position === undefined || isCellPosition(position, size)) &&
        isFiniteNumber(candidate.value) &&
        candidate.value > 0 &&
        // The count is the number of tiles the spawn inserts.
        (count === undefined ||
          (isFiniteNumber(count) && Number.isInteger(count) && count >= 1))
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
        // INVARIANT, exactly as src/engine/hooks.ts declares it: `score`, `over`
        // and `won` are transformable and these three are not.
        candidate.moved === original.moved &&
        candidate.board === original.board &&
        isFiniteNumber(candidate.score) &&
        typeof candidate.over === 'boolean' &&
        typeof candidate.won === 'boolean' &&
        // CHANGED: pinned to the dispatched value, where any boolean used to be
        // admitted. The engine DERIVES `terminated` after the dispatch, so a
        // handler that wrote it changed nothing the engine went on to use while
        // every later handler in the chain read the untruthful value.
        // DL-HOOKBUS-09.
        candidate.terminated === original.terminated
      );
    }

    case 'onStageEnd': {
      const original = dispatched as HookPayloadMap['onStageEnd'];

      return (
        hasExactMembers(candidate, ['stageIndex', 'cleared', 'score']) &&
        isNonNegativeInteger(candidate.stageIndex) &&
        // INVARIANT, exactly as src/engine/hooks.ts declares it: `cleared` and
        // `score` are transformable and the index is not. CHANGED as the
        // `onStageStart` index was, and for the same reason. DL-HOOKBUS-09.
        candidate.stageIndex === original.stageIndex &&
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
 * Projects one dispatch-input payload onto the payload handlers see.
 *
 * @param hook Hook being dispatched.
 * @param payload Payload the caller supplied, carrying live engine objects.
 * @param board The board view built for this dispatch, reused as the
 *   payload's `board` so a handler reads the same view through the payload and
 *   through its context.
 * @returns The payload handlers receive.
 */
function viewedPayload<K extends HookName>(
  hook: K,
  payload: HookDispatchPayloadMap[K],
  board: ReadonlyGridView,
): HookPayloadMap[K] {
  if (hook === 'onBeforeMove' || hook === 'onAfterMove') {
    return {
      ...(payload as object),
      board,
    } as unknown as HookPayloadMap[K];
  }

  if (hook === 'onMerge') {
    const merge = payload as HookDispatchPayloadMap['onMerge'];

    return {
      ...(merge as object),
      source: projectTile(merge.source),
      target: projectTile(merge.target),
    } as unknown as HookPayloadMap[K];
  }

  return payload as unknown as HookPayloadMap[K];
}

/**
 * Copies one payload for one handler.
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
 * @param grid Live board.
 * @returns The frozen facade.
 */
export function createReadonlyGridView(
  grid: EnvironmentGrid,
): ReadonlyGridView {
  return readonlyGridView(grid);
}

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

/** One live tile, as the merge dispatch payload declares it. */
type DispatchTile = HookDispatchPayloadMap['onMerge']['source'];

/**
 * Builds the frozen projection a handler reads one tile through.
 *
 * @param tile Live tile.
 * @returns The frozen projection.
 */
function readonlyTileView(tile: DispatchTile): ReadonlyTileView {
  const previous = tile.previousPosition;

  return Object.freeze({
    x: tile.x,
    y: tile.y,
    value: tile.value,
    previousPosition:
      previous === null || previous === undefined
        ? null
        : Object.freeze({ x: previous.x, y: previous.y }),
  });
}

/**
 * Projects a merge payload's tile member where it is a tile, and carries the
 * member across untouched where it is not.
 *
 * @param candidate Value the payload carried.
 * @returns The frozen projection, or `candidate` unchanged.
 */
function projectTile(candidate: DispatchTile): ReadonlyTileView {
  if (!isRecord(candidate)) {
    return candidate;
  }

  return readonlyTileView(candidate);
}

/**
 * One handler's randomness transaction: the frozen facade it draws through,
 * and the two operations the bus resolves it with.
 */
interface RngTransaction {
  /** The facade handed to the handler on its context. */
  readonly view: ReadonlyRngView;

  /**
   * Adopts the draws the handler took, advancing each real substream by the
   * number of draws its fork consumed.
   */
  commit(): void;

  /**
   * Abandons the draws the handler took. The forks are dropped and no real
   * substream has moved, so a handler that drew and then threw has consumed no
   * randomness and the sequences the engine and every later handler read are
   * unchanged.
   */
  rollback(): void;
}

/**
 * Opens one handler's randomness transaction over the run's substreams.
 *
 * THE RANDOMNESS BOUNDARY. `stream` hands back a FORK of the named substream
 * rather than the substream itself, memoised so the instance-stability
 * contract holds within one dispatch: a handler that addresses one name twice
 * draws from one fork. The real substreams are advanced only by `commit()`, so
 * a handler that draws and then throws consumes no randomness and shifts no
 * later spawn — which is what keeps a failed handler unable to change a seeded
 * run. Decision DL-HOOKBUS-04.
 *
 * `snapshotCursors` reports the fork's position for a substream the handler
 * has drawn from and the real position for the rest, so a handler observes its
 * own consumption.
 *
 * @param rng The run's substreams.
 * @returns The transaction.
 */
function openRngTransaction(rng: EnvironmentRng): RngTransaction {
  // One fork per substream name the handler addresses, with the position the
  // real substream stood at when the fork was taken.
  const forks = new Map<
    EnvironmentStreamName,
    { readonly fork: EnvironmentStream; readonly from: number }
  >();

  const view: ReadonlyRngView = Object.freeze({
    seed: rng.seed,

    stream: (name: EnvironmentStreamName): EnvironmentStream => {
      const held = forks.get(name);

      if (held !== undefined) {
        return held.fork;
      }

      const live = rng.stream(name);
      const opened = { fork: live.fork(), from: live.cursor };

      forks.set(name, opened);

      return opened.fork;
    },

    snapshotCursors: (): EnvironmentCursors => {
      const cursors = rng.snapshotCursors();

      for (const [name, opened] of forks) {
        cursors[name] = opened.fork.cursor;
      }

      return cursors;
    },
  });

  return {
    view,

    commit(): void {
      for (const [name, opened] of forks) {
        const live = rng.stream(name);
        const taken = opened.fork.cursor - opened.from;

        for (let replayed = 0; replayed < taken; replayed += 1) {
          live.next();
        }
      }

      forks.clear();
    },

    rollback(): void {
      forks.clear();
    },
  };
}

/**
 * A transaction that records nothing and resolves to nothing, for a dispatch
 * whose environment carries no usable board or no usable rules.
 */
const INERT_EFFECT_TRANSACTION: BoardEffectTransaction = Object.freeze({
  queue: INERT_BOARD_EFFECTS,
  commit: (): number => 0,
  rollback: (): number => 0,
});

/**
 * Opens one handler's board-effect transaction over the dispatch environment.
 *
 * @param environment The dispatch's live collaborators.
 * @param hook Hook being dispatched, which decides which of the two write
 *   bands the queue accepts.
 * @returns The transaction, or the inert one where the environment carries
 *   no board with a `serialize` member or no rules object.
 */
function openEffectTransaction(
  environment: HookEnvironment,
  hook: HookName,
): BoardEffectTransaction {
  const grid = environment.grid;
  const config = environment.config;

  if (
    typeof grid !== 'object' ||
    grid === null ||
    typeof grid.serialize !== 'function' ||
    typeof config !== 'object' ||
    config === null
  ) {
    return INERT_EFFECT_TRANSACTION;
  }

  // `onMerge` is dispatched from inside the move walk, so its queue refuses
  // every cell write and accepts the two rules commands alone.
  return openBoardEffects(grid, grid, config, {
    lattice: hook !== 'onMerge',
    rebuild: hook !== 'onMerge' && hook !== 'onSpawn',
  });
}

/**
 * Reads the pickup index a subscriber is registered at.
 *
 * @param requested Index the subscriber declared, where it declared one.
 * @param appended Index the bus assigns to an appended subscriber.
 * @returns `requested` when it is a finite number, and `appended` otherwise.
 */
function resolvePickupIndex(
  requested: number | undefined,
  appended: number,
): number {
  return requested !== undefined && Number.isFinite(requested)
    ? requested
    : appended;
}

/** Orders two registrations by pickup index, then by registration sequence. */
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
  // A READER, not a captured value: `HookBusOptions.correlationId` may be a
  // shared scope, and every report below reads it at report time.
  const readCorrelationId = correlationReader(options.correlationId);
  const reporter = options.reporter ?? NOOP_ENGINE_REPORTER;
  const tracing = options.tracing;

  /** Registrations held now, kept in pickup order by `byPickupOrder`. */
  const registrations: Registration[] = [];

  /**
   * How many dispatches are on the stack. Above zero, `register` and
   * `unregister` defer their edit to `pending` so a walk in progress sees a
   * stable array.
   */
  let dispatchDepth = 0;

  /** Edits deferred while a dispatch walks `registrations`. */
  const pending: (() => void)[] = [];

  /**
   * ADDED: registrations accepted while a dispatch is in progress, keyed by
   * identifier, held from the moment `register` accepts one until its deferred
   * insertion lands. `findRegistration` reads it, so an identifier is held from
   * acceptance rather than from insertion. DL-HOOKBUS-10.
   */
  const pendingRegistrations = new Map<string, Registration>();

  /** Counter rows keyed by hook name, created on first use. */
  const hookRows = new Map<HookName, HookCounterRow>();

  /**
   * Counter rows keyed by subscriber identifier, created on first use and kept
   * after the subscriber is removed.
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
      reporter.onCount?.({
        correlationId: readCorrelationId(),
        metric,
        value,
        hook,
      });
    });
  };

  /**
   * Runs `body` inside an injected wrapper, or directly where none was
   * injected.
   *
   * The wrapper is expected to call `body` once and to return its value.
   * `body` runs exactly once whatever the wrapper does, and the value and the
   * throw a caller sees are the body's own.
   *
   * @param wrap The injected wrapper, or `undefined`.
   * @param hook Hook the work belongs to, carried into the fault count.
   * @param body The work to run.
   * @returns Whatever `body` returned.
   */
  const traced = <T>(
    wrap: ((run: () => T) => T) | undefined,
    hook: HookName,
    body: () => T,
  ): T => {
    if (wrap === undefined) {
      return body();
    }

    /** Whether the body has been entered. Raised BEFORE it runs. */
    let started = false;

    /** Whether the body returned. */
    let settled = false;

    /** Whether the body threw, which is separate from the wrapper throwing. */
    let failed = false;

    let thrown: unknown;
    let held: T | undefined;

    const inner = (): T => {
      if (started) {
        count(TRACING_FAULT_METRIC, hook);

        if (failed) {
          throw thrown;
        }

        return held as T;
      }

      started = true;

      try {
        const value = body();

        held = value;
        settled = true;

        return value;
      } catch (error: unknown) {
        failed = true;
        thrown = error;

        throw error;
      }
    };

    let returned: T;

    try {
      returned = wrap(inner);
    } catch (error: unknown) {
      if (failed) {
        // The failure belongs to the work, not to the instrumentation: the
        // work's own value is rethrown for the caller's `catch` to contain — a
        // wrapper that replaced it is counted and its substitute discarded —
        // and the work is not repeated.
        if (!Object.is(error, thrown)) {
          count(TRACING_FAULT_METRIC, hook);
        }

        throw thrown;
      }

      count(TRACING_FAULT_METRIC, hook);

      return settled ? (held as T) : body();
    }

    if (failed) {
      count(TRACING_FAULT_METRIC, hook);

      throw thrown;
    }

    if (settled) {
      if (!Object.is(returned, held)) {
        count(TRACING_FAULT_METRIC, hook);
      }

      return held as T;
    }

    count(TRACING_FAULT_METRIC, hook);

    return body();
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
   * Deducts charges from one registration, and is the ONE writer of `charges`.
   *
   * @param registration Registration to deduct from. Must carry a budget.
   * @param amount Charges to deduct.
   * @returns The number of charges actually deducted.
   */
  const spend = (registration: Registration, amount: number): number => {
    const held = registration.charges;

    if (held === undefined) {
      return 0;
    }

    const available = normaliseCharges(held);
    const taken = Math.min(available, normaliseCharges(amount));

    registration.charges = available - taken;

    if (taken > 0) {
      chargesConsumed += taken;
      subscriberRow(registration.id, registration.pickupIndex).chargesConsumed +=
        taken;
      count(CHARGE_METRIC, undefined, taken);
    }

    return taken;
  };

  /**
   * Counts the board and rules commands one handler's transaction resolved to,
   * and says nothing at all for a handler that recorded none — which is every
   * handler that only reads.
   *
   * @param metric Counter the amount is added to.
   * @param hook Hook the commands were recorded under.
   * @param resolved How many commands were written or dropped.
   */
  const countEffects = (
    metric: string,
    hook: HookName,
    resolved: number,
  ): void => {
    if (resolved > 0) {
      count(metric, hook, resolved);
    }
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
          correlationId: readCorrelationId(),

          hook,
          subscriberId: id,
          error,
        });
      });
    }

    note(hook, id, 'failed');
  };

  const findRegistration = (id: string): Registration | undefined => {
    const held = registrations.find(
      // A record already marked removed is not held any more, even while its
      // array edit waits for the dispatch in progress to return, so the
      // identifier is free to be registered again at once.
      (registration): boolean => !registration.removed && registration.id === id,
    );

    if (held !== undefined) {
      return held;
    }

    // ADDED: a registration accepted during a dispatch is held even though its
    // insertion is still deferred. Without this the duplicate check below could
    // not see it, so registering one new identifier twice inside a single
    // dispatch queued two inserts and the bus dispatched to the same subscriber
    // twice from the next hook onwards. DL-HOOKBUS-10.
    const queued = pendingRegistrations.get(id);

    return queued !== undefined && !queued.removed ? queued : undefined;
  };

  /**
   * Reads the registrations still held, skipping any whose removal is deferred
   * behind a dispatch in progress.
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
   * and `state` are read from the subscriber at call time, and `state` is
   * COPIED, so a caller reading a subscription holds no object the bus
   * dispatches from.
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
      state: copyState(registration.state),
    });
  };

  /**
   * Builds the read-only snapshot of one registration `subscribers` returns.
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
      state: copyState(registration.state),
    });

  /**
   * The one path that writes A CHARGE BUDGET.
   *
   * @param id Subscriber to deduct from.
   * @param amount Charges to deduct.
   * @returns What the deduction resolved to.
   */
  const deductCharge = (id: string, amount: number): ChargeConsumption => {
    const registration = findRegistration(id);

    if (registration === undefined) {
      return UNHELD_CONSUMPTION;
    }

    if (registration.charges === undefined) {
      return UNLIMITED_CONSUMPTION;
    }

    // Written by `spend` and by nothing else, so the ledger, the
    // per-subscriber row and the counter cannot diverge between a manual
    // activation and a handler's own request.
    const taken = spend(registration, amount);

    return Object.freeze({
      held: true,
      limited: true,
      consumed: taken,
      remaining: normaliseCharges(registration.charges ?? 0),
    });
  };

  /* ------------------------------------------------------------------------
   * The shared event channel
   * ---------------------------------------------------------------------- */

  /**
   * The channel peers subscribe to.
   *
   * Constructed with a reporter carrying the LISTENER CHANNEL ALONE: a relayed
   * event is already counted by the emitter that emitted it, and a second count
   * here would double every `engine.event.emit`. A peer that throws is still
   * reported, because containment that reports nothing is indistinguishable
   * from a peer that never ran. DL-HOOKBUS-06.
   */
  const relayReporter: EngineReporter = Object.freeze({
    onListenerError: (report: EngineListenerErrorReport): void => {
      deliver((): void => {
        reporter.onListenerError?.(report);
      });
    },
  });

  const events = createEngineEvents({
    correlationId: options.correlationId,
    reporter: relayReporter,
  });

  /** Emitters already relayed, so a repeated attach registers no second set. */
  const relayed = new Set<EngineEvents>();

  const attachEvents = (source: EngineEvents): EngineEventSubscription => {
    if (relayed.has(source)) {
      count(RELAY_REATTACHED_METRIC);

      return (): void => {
        // Nothing was registered: the source was already relayed, and the
        // handle of the call that registered it is the one that removes it.
        return;
      };
    }

    relayed.add(source);

    // One listener per name, appended in `ENGINE_EVENT_NAMES` order. The
    // payload is passed on as it arrived: the board, the tiles and the score
    // travel by reference exactly as they do on the source.
    //
    // CHANGED: taken one at a time inside a guard, where they used to be taken
    // by one `map` over the names. An emitter whose `on` raised part-way through
    // that map left every listener taken before the throw registered with no
    // handle to release them, and left `source` marked relayed — so the relay
    // could neither be released nor attached again. DL-HOOKBUS-11.
    const releases: EngineEventSubscription[] = [];

    try {
      for (const name of ENGINE_EVENT_NAMES) {
        releases.push(
          source.on(
            name,
            (payload: EngineEventPayloadMap[typeof name]): void => {
              events.emit(name, payload);
            },
          ),
        );
      }
    } catch (error: unknown) {
      // Everything taken before the throw is released, and the marker is
      // cleared, so a caller that fixes the emitter and attaches again gets a
      // full relay rather than the no-op handle of an already-relayed source.
      for (const release of releases) {
        try {
          release();
        } catch {
          // A release that raises during a rollback cannot be recovered from
          // and must not displace the failure being reported.
        }
      }

      relayed.delete(source);

      throw error;
    }

    count(RELAY_ATTACHED_METRIC, undefined, releases.length);

    let released = false;

    return (): void => {
      if (released) {
        return;
      }

      released = true;
      relayed.delete(source);

      for (const release of releases) {
        release();
      }
    };
  };

  return Object.freeze({
    events,
    attachEvents,

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

      const registration: Registration = {
        id,
        hooks: copyHandlerTable(subscriber.hooks),
        pickupIndex,
        sequence: nextSequence,
        charges: subscriber.charges,
        state: copyState(subscriber.state),
        degraded: false,
        removed: false,
      };

      // ADDED: held under its identifier for as long as its insertion is
      // deferred. DL-HOOKBUS-10.
      if (dispatchDepth > 0) {
        pendingRegistrations.set(id, registration);
      }

      // Inserted in pickup order, and deferred behind a dispatch in progress
      // so the walk sees a stable membership.
      applyOrDefer((): void => {
        // Compared first, so an identifier registered again after being
        // unregistered inside the same dispatch keeps the entry of the LATER
        // acceptance.
        if (pendingRegistrations.get(id) === registration) {
          pendingRegistrations.delete(id);
        }

        // ADDED: an identifier unregistered while its own insertion was still
        // deferred is not inserted at all, so the array never holds a record
        // whose removal has already been accounted for. DL-HOOKBUS-10.
        if (registration.removed) {
          return;
        }

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
      payload: HookDispatchPayloadMap[K],
      environment: HookEnvironment,
    ): HookDispatchResult<K> {
      // The walk below is the dispatch; this member is the injected wrapper's
      // seam around it.
      const traceDispatchBoundary = tracing?.traceHookDispatch;
      const wrap =
        typeof traceDispatchBoundary === 'function'
          ? (run: () => HookDispatchResult<K>): HookDispatchResult<K> =>
              traceDispatchBoundary(hook, run)
          : undefined;

      return traced(wrap, hook, (): HookDispatchResult<K> => {

        hookRow(hook).dispatched += 1;
        totals.dispatched += 1;
        count(DISPATCH_METRIC, hook);

        // The board is projected once per dispatch and frozen: every member
        // delegates to the live lattice, so one facade reports the board as it
        // stands however many handlers have written to it.
        const board = readonlyGridView(environment.grid);

        // The payload as the last handler that returned and validated left it.
        let accumulated = viewedPayload(hook, payload, board);
        let invoked = 0;
        let skipped = 0;
        let failed = 0;
        let rejected = 0;
        let chargesSpent = 0;
        let effectsApplied = 0;
        let effectsRefused = 0;
        const appliedEffects: BoardEffect[] = [];

        // Order and membership are read once, ahead of the walk.
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

            // THE CHARGE GUARD, and the one place a spent budget withholds a
            // handler.
            //
            // CHANGED: it withholds ALL SIX hooks, with no hook exempted, so a
            // subscriber whose budget is spent runs no handler and applies no
            // effect — the frozen requirement that a limited-charge relic stops
            // firing once exhausted (AAP R3, V6). Standing rules a relic's
            // persisted `state` slot records are reinstated on the rehydration
            // path by `applyStandingRelicRules` of
            // src/relics/relic-registry.ts, which dispatches nothing.
            // DL-HOOKBUS-07.
            if (isChargeSpent(charges)) {
              skipped += 1;
              noteSkip(hook, id, 'exhausted');

              continue;
            }

            // The handler's randomness transaction. Draws it takes go to forks
            // and reach the run's substreams only if its return is adopted.
            const draws = openRngTransaction(environment.rng);

            // The handler's board-effect transaction. Commands it records are
            // validated against a projection of the live board and reach the
            // lattice and the rules only if its return is adopted.
            const effects = openEffectTransaction(environment, hook);

            // The handler's charge request, accumulated across however many
            // times it asks and spent only by the commit below.
            let requested = 0;
            let requestsOpen = true;

            const context: HookContext = {
              config: readonlyRulesView(environment.config),
              rng: draws.view,
              grid: board,
              effects: effects.queue,
              correlationId: readCorrelationId(),
              hook,
              subscriberId: id,
              pickupOrder: subscription.pickupOrder,
              charges,
              spendCharge: (amount = 1): boolean => {
                if (!requestsOpen || charges === undefined) {
                  return false;
                }

                const wanted = normaliseCharges(amount);

                if (wanted === 0) {
                  return false;
                }

                // Capped at the budget held, so repeated requests within one
                // dispatch cannot ask for more than there is and the commit
                // below can never underflow.
                requested = Math.min(
                  normaliseCharges(charges),
                  requested + wanted,
                );

                return requested > 0;
              },

              // A COPY of the slot, so a handler that writes into a nested
              // member writes into its own copy.
              state: copyState(registration.state),
            };

            // The handler writes into a payload of its own.
            const working = copyPayload(hook, accumulated);

            invoked += 1;
            note(hook, id, 'invoked');

            try {
              // The handler boundary's own seam. The wrapper rethrows what the
              // handler threw, so the `catch` below still owns containment.
              const traceHandlerBoundary = tracing?.traceRelicHandler;
              const wrapHandler =
                typeof traceHandlerBoundary === 'function'
                  ? (run: () => unknown): unknown =>
                      traceHandlerBoundary(hook, id, run)
                  : undefined;
              const returned: unknown = traced(
                wrapHandler,
                hook,
                (): unknown => subscription.handler(working, context),
              );
              // The request window closes with the return, before the return
              // is judged, so nothing a handler asks for after this point can
              // join the commit below.
              requestsOpen = false;

              const candidate: unknown =
                returned === undefined || returned === null ? working : returned;

              if (isValidPayload(hook, candidate, accumulated, environment)) {
                accumulated = candidate as HookPayloadMap[K];

                // The state slot, the draws and the board effects are
                // committed with the payload, so a handler's carried-over
                // state, the randomness it consumed and the board and rules it
                // wrote are adopted together or not at all.
                registration.state = copyState(context.state);
                draws.commit();

                // Read BEFORE the commit, which empties the queue: the list is
                // what reached the board, in the order it reached it.
                const pending = effects.queue.requested();
                const written = effects.commit();

                if (written > 0) {
                  appliedEffects.push(...pending);
                }

                effectsApplied += written;
                countEffects(EFFECT_APPLIED_METRIC, hook, written);

                // The charge spend, and the only one on the dispatch path.
                if (requested > 0) {
                  chargesSpent += spend(registration, requested);
                }
              } else {
                rejected += 1;
                note(hook, id, 'rejected');
                draws.rollback();
                countEffects(EFFECT_DROPPED_METRIC, hook, effects.rollback());
              }
            } catch (error: unknown) {
              requestsOpen = false;

              // Nothing the handler wrote, drew or recorded is kept.
              draws.rollback();
              countEffects(EFFECT_DROPPED_METRIC, hook, effects.rollback());
              failed += 1;
              noteThrow(registration, hook, error);
            } finally {
              // Counted once per handler, on every path out of it: a refused
              // command is reported whether the handler went on to return, to
              // have its return refused, or to throw.
              effectsRefused += effects.queue.refused;
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
          chargesConsumed: chargesSpent,
          effectsApplied,
          effects: Object.freeze([...appliedEffects]),
          effectsRefused,
        });
      });
    },

    consumeCharge(id: string, amount = 1): ChargeConsumption {
      // Through the one deduction rule, which `HookContext.spendCharge`'s
      // commit also reaches, so a manual activation and a handler's own
      // request cannot diverge in the ledger, the per-subscriber row or the
      // counter.
      return deductCharge(id, amount);
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
      // Extension with no vanilla source. Each element is a frozen snapshot
      // built by `snapshotOf`, never the object the caller registered.
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
        correlationId: readCorrelationId(),

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
