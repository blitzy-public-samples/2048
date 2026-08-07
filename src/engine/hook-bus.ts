// The hook bus: pickup-order dispatch of the six engine hooks.
//
// Supersedes the three-name publish/subscribe bus of
// js/keyboard_input_manager.js L18-L32. Its `on()` at L18-L23 lazily
// created the array keyed by event name and pushed the callback onto it,
// and its `emit()` at L25-L32 read that array back and invoked each
// callback inline with one argument, returning nothing.
//
// That append-and-invoke-inline shape is carried forward. Four properties
// are added, and none of the four has a vanilla source:
//
//   pickup order      every subscriber carries a pickup-order index and
//                     dispatch walks the subscribers bound to a hook in
//                     that index's order.
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
//
// Invariants of this module: it names no engine module other than
// ./hooks and ./types, reads no DOM, performs no I/O, consumes no
// randomness, reads no clock, and is synchronous throughout. Nothing it
// hands a handler re-enters dispatch, and it branches on no subscriber
// identity.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import type {
  HookContext,
  HookEnvironment,
  HookHandler,
  HookHandlerTable,
  HookName,
  HookPayloadMap,
  HookSubscription,
} from './hooks';
import { HOOK_NAMES } from './hooks';
import type { EngineReporter } from './types';
import { NOOP_ENGINE_REPORTER } from './types';

/* --------------------------------------------------------------------------
 * Counter names
 * ----------------------------------------------------------------------- */

/** Counter name for one dispatch of a hook. */
const DISPATCH_METRIC = 'engine.hook.dispatch';

/** Counter name for one handler invocation. */
const HANDLER_METRIC = 'engine.hook.handler';

/** Counter name for a handler skipped by the charge guard. */
const EXHAUSTED_METRIC = 'engine.hook.exhausted';

/** Counter name for a handler skipped for a degraded subscriber. */
const DEGRADED_METRIC = 'engine.hook.degraded';

/** Counter name for a handler skipped for a removed subscriber. */
const DETACHED_METRIC = 'engine.hook.detached';

/** Counter name for a handler return that was not a payload. */
const REJECTED_PAYLOAD_METRIC = 'engine.hook.payload.rejected';

/** Counter name for a handler that threw and was contained. */
const HANDLER_ERROR_METRIC = 'engine.hook.error';

/** Counter name for a registration that was accepted. */
const REGISTERED_METRIC = 'engine.hook.subscriber.registered';

/** Counter name for a registration that was rejected. */
const INVALID_SUBSCRIBER_METRIC = 'engine.hook.subscriber.invalid';

/** Counter name for a subscriber that was removed. */
const REMOVED_METRIC = 'engine.hook.subscriber.removed';

/** Counter name for charges deducted, added by the amount deducted. */
const CHARGE_METRIC = 'engine.hook.charge.consumed';

/* --------------------------------------------------------------------------
 * Registration contract
 * ----------------------------------------------------------------------- */

/**
 * What is registered on the bus.
 *
 * The behavioural slice of the relic data shape: the identifier, the
 * `hooks` handler table, the optional `charges` budget and the optional
 * `state` slot. The bus reads no member beyond these four.
 */
export interface HookSubscriber {
  /**
   * Identifier, carried into every report and into every dispatch
   * context. A second registration under an identifier already held is
   * rejected.
   */
  readonly id: string;

  /** Handlers this subscriber binds, keyed by hook name. */
  readonly hooks: HookHandlerTable;

  /**
   * Position in pickup order, which is the ordering authority of every
   * dispatch. Absent on a subscriber appended to the end of the order,
   * which is the default path: the bus then assigns an index above every
   * index it has assigned or been given. A value that is not a finite
   * number is treated as absent.
   */
  readonly pickupOrder?: number;

  /**
   * Charges remaining. Absent on a subscriber carrying no charge budget,
   * which is never charge-guarded; present and not above zero, every
   * handler of the subscriber is skipped. Written by `consumeCharge` and
   * by nothing else on the bus.
   */
  charges?: number;

  /**
   * The subscriber's own state slot. Carried into each dispatch context
   * and written back from that context once the handler returns.
   */
  state?: unknown;
}

/** The reason a subscriber's handler was not invoked. */
export type HookSkipReason = 'exhausted' | 'degraded' | 'detached';

/**
 * One hook's dispatch outcome.
 *
 * Returned by `dispatch` alongside the payload, so a caller reads what
 * happened without subscribing to the reporter.
 */
export interface HookDispatchResult<K extends HookName> {
  /** The payload after every handler that ran. */
  readonly payload: HookPayloadMap[K];

  /** Handlers that were invoked. */
  readonly invoked: number;

  /** Handlers skipped, for any of the three reasons. */
  readonly skipped: number;

  /** Handlers that threw and were contained. */
  readonly failed: number;

  /** Handler returns that were not payloads and were discarded. */
  readonly rejected: number;
}

/**
 * The outcome of one `consumeCharge` call.
 *
 * `held` and `limited` separate the three states a caller distinguishes
 * without consulting the subscriber: an identifier that is not
 * registered reports `held: false`; a registered subscriber carrying no
 * charge budget reports `limited: false`; and a charge-carrying
 * subscriber reports both as `true` with `remaining` present.
 */
export interface ChargeConsumption {
  /** Whether the identifier is registered. */
  readonly held: boolean;

  /** Whether the subscriber carries a charge budget. */
  readonly limited: boolean;

  /** Charges the call deducted. Zero when it deducted none. */
  readonly consumed: number;

  /**
   * Charges the subscriber holds after the call: a whole number at or
   * above zero. Absent on an unregistered identifier and on a
   * subscriber carrying no charge budget.
   */
  readonly remaining?: number | undefined;
}

/* --------------------------------------------------------------------------
 * Metrics
 * ----------------------------------------------------------------------- */

/**
 * Handler-level counts, reported per hook, per subscriber and in total.
 *
 * Extension with no vanilla source: js/keyboard_input_manager.js counted
 * nothing.
 */
export interface HookHandlerCounters {
  /** Handlers invoked. */
  readonly invoked: number;

  /** Handlers skipped by the charge guard. */
  readonly skippedExhausted: number;

  /** Handlers skipped for a subscriber that had degraded. */
  readonly skippedDegraded: number;

  /** Handlers skipped for a subscriber that had been removed. */
  readonly skippedDetached: number;

  /** Handler returns that were not payloads and were discarded. */
  readonly rejected: number;

  /** Handlers that threw and were contained. */
  readonly failed: number;
}

/** One hook's counts, or the totals across every hook. */
export interface HookCounters extends HookHandlerCounters {
  /** Dispatches of the hook. */
  readonly dispatched: number;
}

/** One subscriber's counts and its state as at the snapshot. */
export interface HookSubscriberMetrics extends HookHandlerCounters {
  /** Identifier the subscriber was registered under. */
  readonly id: string;

  /** Position in pickup order, last known where it is not registered. */
  readonly pickupOrder: number;

  /** Whether the identifier is registered now. */
  readonly registered: boolean;

  /** Whether the registration is marked degraded. */
  readonly degraded: boolean;

  /**
   * Charges the subscriber holds now. Absent where it carries no charge
   * budget or is not registered.
   */
  readonly charges?: number | undefined;

  /** Charges deducted from it by `consumeCharge`. */
  readonly chargesConsumed: number;
}

/**
 * Everything the bus counts, as `metrics()` reports it.
 *
 * Extension with no vanilla source. Read by the observability layer,
 * which the engine never imports.
 */
export interface HookBusMetrics {
  /** Correlation identifier every report from this bus carries. */
  readonly runId: string;

  /** Subscribers registered at the moment of the snapshot. */
  readonly registered: number;

  /** Registrations accepted over the bus's lifetime. */
  readonly acceptedRegistrations: number;

  /** Registrations rejected over that lifetime. */
  readonly rejectedRegistrations: number;

  /** Subscribers removed over that lifetime. */
  readonly removedSubscribers: number;

  /** Charges deducted over that lifetime. */
  readonly chargesConsumed: number;

  /** Reporter calls that threw and were contained. */
  readonly reporterFaults: number;

  /**
   * The most recent contained reporter throw, as text. Absent until one
   * has occurred.
   */
  readonly lastReporterFault?: string | undefined;

  /** Identifiers marked degraded, in pickup order. */
  readonly degraded: readonly string[];

  /** Counts across every hook. */
  readonly totals: HookCounters;

  /** Counts per hook, keyed by the six names of `HOOK_NAMES`. */
  readonly hooks: Readonly<Record<HookName, HookCounters>>;

  /**
   * Counts per subscriber, ordered by pickup order and then by
   * registration sequence. A subscriber's row outlives its
   * registration, with `registered` reporting `false` from then on.
   */
  readonly subscribers: readonly HookSubscriberMetrics[];
}

/* --------------------------------------------------------------------------
 * Bus
 * ----------------------------------------------------------------------- */

/**
 * The bus.
 *
 * Frozen: the eight members below are its whole surface. It exposes no
 * way to reach itself from a handler.
 */
export interface HookBus {
  /**
   * Registers a subscriber.
   *
   * Ported from js/keyboard_input_manager.js L18-L23, `on()`, which
   * pushed a callback onto the array keyed by event name. A subscriber
   * carrying no `pickupOrder` is appended to the end of pickup order,
   * which is that append; one carrying a finite `pickupOrder` takes
   * that position.
   *
   * @param subscriber Subscriber to register.
   * @returns `true` when it was registered, `false` when its identifier
   *   is already held, is not a non-empty string, or its handler table
   *   binds no callable handler or binds a value that is not callable.
   */
  register(subscriber: HookSubscriber): boolean;

  /**
   * Removes a subscriber.
   *
   * Extension with no vanilla source: js/keyboard_input_manager.js
   * offered no removal path. Removing an identifier that is not held
   * changes nothing and reports `false`, so a repeated call is safe. A
   * removal made while a dispatch is walking takes effect within that
   * walk: the subscriber's remaining handlers are skipped.
   *
   * @param id Identifier the subscriber was registered under.
   * @returns `true` when a registration was removed.
   */
  unregister(id: string): boolean;

  /**
   * Dispatches one hook to every subscriber bound to it, in pickup
   * order.
   *
   * Ported from js/keyboard_input_manager.js L25-L32, `emit()`, which
   * invoked each callback for the name inline and returned nothing.
   * Order, membership and the four added properties of this module
   * apply.
   *
   * @param hook Hook to dispatch.
   * @param payload Payload the first handler receives.
   * @param environment The rules, substreams and board in force,
   *   supplied per dispatch.
   * @returns The accumulated payload and the dispatch's counts. Throws
   *   nothing that a handler or the reporter threw.
   */
  dispatch<K extends HookName>(
    hook: K,
    payload: HookPayloadMap[K],
    environment: HookEnvironment,
  ): HookDispatchResult<K>;

  /**
   * Deducts charges from one subscriber, and is the only path that
   * writes `charges`.
   *
   * Extension with no vanilla source. Deducts at most the charges the
   * subscriber holds, so the budget never falls below zero and a call
   * against a spent budget deducts nothing. A stored budget that is not
   * a whole number at or above zero is normalised to one as it is
   * written.
   *
   * @param id Identifier of the subscriber to deduct from.
   * @param amount Charges to deduct. Rounded towards zero and clamped
   *   to zero from below; defaults to `1`.
   * @returns What the call deducted and what remains.
   */
  consumeCharge(id: string, amount?: number): ChargeConsumption;

  /**
   * Reads the identifiers of the registrations marked degraded, in
   * pickup order.
   *
   * Extension with no vanilla source. A registration is marked when one
   * of its handlers throws and stays marked for the rest of its
   * registration; registering the identifier again after removing it
   * clears the mark.
   *
   * @returns A frozen array, empty when none is marked.
   */
  degraded(): readonly string[];

  /**
   * Reads the subscriptions bound to one hook, in pickup order.
   *
   * Extension with no vanilla source. Includes the subscriptions of a
   * degraded registration, which `degraded()` reports separately.
   *
   * @param hook Hook to resolve.
   * @returns A frozen array, built fresh on each call. The `charges`
   *   and `state` members carry the subscriber's values as at the call.
   */
  subscriptions<K extends HookName>(
    hook: K,
  ): readonly HookSubscription<K>[];

  /**
   * Reads the registered subscribers in pickup order.
   *
   * Extension with no vanilla source.
   *
   * @returns A frozen array, built fresh on each call. The elements are
   *   the registered objects themselves.
   */
  subscribers(): readonly HookSubscriber[];

  /**
   * Reads everything the bus counts.
   *
   * Extension with no vanilla source.
   *
   * @returns A frozen snapshot, built fresh on each call.
   */
  metrics(): HookBusMetrics;
}

/** Construction parameters. */
export interface HookBusOptions {
  /**
   * Correlation identifier of the run, carried into every report and
   * every dispatch context. Defaults to the empty string.
   */
  readonly runId?: string;

  /**
   * Sink for caught handler errors and counters. Defaults to
   * `NOOP_ENGINE_REPORTER`, so the bus is constructible with no
   * argument at all.
   */
  readonly reporter?: EngineReporter;
}


/* --------------------------------------------------------------------------
 * Internal state
 * ----------------------------------------------------------------------- */

/** A handler-level outcome one dispatch records. */
type HandlerOutcome =
  | 'invoked'
  | 'skippedExhausted'
  | 'skippedDegraded'
  | 'skippedDetached'
  | 'rejected'
  | 'failed';

/** The counter name each handler-level outcome is reported under. */
const OUTCOME_METRIC: Readonly<Record<HandlerOutcome, string>> =
  Object.freeze({
    invoked: HANDLER_METRIC,
    skippedExhausted: EXHAUSTED_METRIC,
    skippedDegraded: DEGRADED_METRIC,
    skippedDetached: DETACHED_METRIC,
    rejected: REJECTED_PAYLOAD_METRIC,
    failed: HANDLER_ERROR_METRIC,
  });

/** The outcome each skip reason is recorded as. */
const SKIP_OUTCOME: Readonly<Record<HookSkipReason, HandlerOutcome>> =
  Object.freeze({
    exhausted: 'skippedExhausted',
    degraded: 'skippedDegraded',
    detached: 'skippedDetached',
  });

/** Mutable counters behind `HookHandlerCounters`. */
interface HandlerCounterRow {
  invoked: number;
  skippedExhausted: number;
  skippedDegraded: number;
  skippedDetached: number;
  rejected: number;
  failed: number;
}

/** Mutable counters behind `HookCounters`. */
interface HookCounterRow extends HandlerCounterRow {
  dispatched: number;
}

/** Mutable counters behind `HookSubscriberMetrics`. */
interface SubscriberCounterRow extends HandlerCounterRow {
  /** Identifier the row belongs to. */
  readonly id: string;

  /** Order in which the identifier was first registered. */
  readonly sequence: number;

  /** Pickup index of its latest registration. */
  pickupOrder: number;

  /** Charges deducted from it. */
  chargesConsumed: number;
}

/**
 * A registration as the bus holds it.
 *
 * `pickupIndex` and `sequence` are fixed at registration, so a
 * subscriber's position and tie-break survive the removal of an earlier
 * one. `degraded` and `removed` are the two flags dispatch reads.
 */
interface Registration {
  readonly subscriber: HookSubscriber;
  readonly pickupIndex: number;
  readonly sequence: number;
  degraded: boolean;
  removed: boolean;
}

/* --------------------------------------------------------------------------
 * Helpers
 * ----------------------------------------------------------------------- */

/**
 * Reports whether a value can be invoked as a handler.
 *
 * @param value Value to test.
 * @returns `true` when it is callable.
 */
function isHandler(value: unknown): boolean {
  return typeof value === 'function';
}

/**
 * Reports whether a handler table is usable.
 *
 * Only the six names of `HOOK_NAMES` are read, so a member under any
 * other key is neither required to be callable nor counted.
 *
 * @param hooks Value supplied as the handler table.
 * @returns `true` when at least one of the six names is bound to a
 *   callable value and none of them is bound to a value that is neither
 *   callable nor absent.
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
 * Reports whether a handler's return value is accepted as the payload
 * the next handler receives.
 *
 * @param value Value the handler returned.
 * @returns `true` when it is a non-null object that is not an array.
 */
function isPayloadLike(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
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
 * Normalises a charge count to a whole number at or above zero.
 *
 * @param value Count to normalise.
 * @returns The count rounded towards zero, with anything below zero and
 *   anything not finite becoming zero.
 */
function normaliseCharges(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.trunc(value));
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
 * Orders two registrations by pickup index, then by registration
 * sequence.
 *
 * Both keys are finite numbers assigned by the bus, and the sequence is
 * unique, so the order this produces is total.
 *
 * @param left First registration.
 * @param right Second registration.
 * @returns A negative number, zero or a positive number.
 */
function byPickupOrder(left: Registration, right: Registration): number {
  return left.pickupIndex === right.pickupIndex
    ? left.sequence - right.sequence
    : left.pickupIndex - right.pickupIndex;
}

/**
 * Orders two subscriber counter rows by pickup index, then by first
 * registration.
 *
 * @param left First row.
 * @param right Second row.
 * @returns A negative number, zero or a positive number.
 */
function bySubscriberOrder(
  left: SubscriberCounterRow,
  right: SubscriberCounterRow,
): number {
  return left.pickupOrder === right.pickupOrder
    ? left.sequence - right.sequence
    : left.pickupOrder - right.pickupOrder;
}

/**
 * Builds a zeroed hook counter row.
 *
 * @returns The row.
 */
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

/**
 * Builds a zeroed subscriber counter row.
 *
 * @param id Identifier the row belongs to.
 * @param pickupOrder Pickup index of the registration that created it.
 * @param sequence Order in which the identifier was first registered.
 * @returns The row.
 */
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

/**
 * Projects a hook counter row to its frozen reported form.
 *
 * @param row Row to read.
 * @returns The frozen counts.
 */
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

/**
 * Projects a subscriber counter row and its registration to the frozen
 * reported form.
 *
 * @param row Row to read.
 * @param registration Its registration, absent once removed.
 * @returns The frozen counts and state.
 */
function freezeSubscriberMetrics(
  row: SubscriberCounterRow,
  registration: Registration | undefined,
): HookSubscriberMetrics {
  return Object.freeze({
    id: row.id,
    pickupOrder: row.pickupOrder,
    registered: registration !== undefined,
    degraded: registration !== undefined && registration.degraded,
    charges: registration?.subscriber.charges,
    chargesConsumed: row.chargesConsumed,
    invoked: row.invoked,
    skippedExhausted: row.skippedExhausted,
    skippedDegraded: row.skippedDegraded,
    skippedDetached: row.skippedDetached,
    rejected: row.rejected,
    failed: row.failed,
  });
}

/**
 * Reads text from a caught value.
 *
 * @param value Value that was thrown.
 * @returns Its message where it is an `Error`, the value itself where it
 *   is a string, its string form where it has one, and a fixed
 *   placeholder otherwise.
 */
function describeError(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return String(value);
  } catch {
    return 'unreadable thrown value';
  }
}


/* --------------------------------------------------------------------------
 * Construction
 * ----------------------------------------------------------------------- */

/** What `consumeCharge` reports for an identifier that is not held. */
const UNHELD_CONSUMPTION: ChargeConsumption = Object.freeze({
  held: false,
  limited: false,
  consumed: 0,
});

/** What it reports for a subscriber carrying no charge budget. */
const UNLIMITED_CONSUMPTION: ChargeConsumption = Object.freeze({
  held: true,
  limited: false,
  consumed: 0,
});

/**
 * Creates a hook bus.
 *
 * @param options Correlation identifier and report sink. Both optional,
 *   and so is the argument itself.
 * @returns A frozen bus.
 *
 * @example
 * ```ts
 * const bus = createHookBus({ runId, reporter });
 *
 * bus.register({
 *   id: 'twin-spawn',
 *   charges: 3,
 *   hooks: {
 *     onSpawn: (payload) => ({ ...payload, value: payload.value * 2 }),
 *   },
 * });
 *
 * const { payload } = bus.dispatch(
 *   'onSpawn',
 *   { position: { x: 0, y: 0 }, value: 2 },
 *   { config, rng, grid },
 * );
 * ```
 */
export function createHookBus(options: HookBusOptions = {}): HookBus {
  const runId = options.runId ?? '';
  const reporter = options.reporter ?? NOOP_ENGINE_REPORTER;

  /** Registrations held now, in the order they were registered. */
  const registrations: Registration[] = [];

  /** Counter rows keyed by hook name, created on first use. */
  const hookRows = new Map<HookName, HookCounterRow>();

  /**
   * Counter rows keyed by subscriber identifier, created on first use
   * and kept after the subscriber is removed.
   */
  const subscriberRows = new Map<string, SubscriberCounterRow>();

  /** Counts summed across every hook. */
  const totals = createHookRow();

  /** Pickup index the next appended subscriber takes. */
  let nextPickupIndex = 0;

  /** Registration sequence the next registration takes. */
  let nextSequence = 0;

  /** Registrations accepted. */
  let acceptedRegistrations = 0;

  /** Registrations rejected. */
  let rejectedRegistrations = 0;

  /** Subscribers removed. */
  let removedSubscribers = 0;

  /** Charges deducted. */
  let chargesConsumed = 0;

  /** Reporter calls that threw and were contained. */
  let reporterFaults = 0;

  /** The most recent contained reporter throw, as text. */
  let lastReporterFault: string | undefined;

  /**
   * Runs one report, containing a throw from the reporter itself.
   *
   * @param report Call to run.
   */
  const deliver = (report: () => void): void => {
    try {
      report();
    } catch (error: unknown) {
      reporterFaults += 1;
      lastReporterFault = describeError(error);
    }
  };

  /**
   * Adds to a counter through the injected reporter.
   *
   * @param metric Counter name.
   * @param hook Hook the count belongs to, where it belongs to one.
   * @param value Amount to add. Defaults to `1`.
   */
  const count = (metric: string, hook?: HookName, value = 1): void => {
    if (reporter.onCount === undefined) {
      return;
    }

    deliver((): void => {
      reporter.onCount?.({ runId, metric, value, hook });
    });
  };

  /**
   * Reads one hook's counter row, creating it on first use.
   *
   * @param hook Hook to read.
   * @returns Its row.
   */
  const hookRow = (hook: HookName): HookCounterRow => {
    const existing = hookRows.get(hook);

    if (existing !== undefined) {
      return existing;
    }

    const created = createHookRow();

    hookRows.set(hook, created);

    return created;
  };

  /**
   * Reads one subscriber's counter row, creating it on first use.
   *
   * @param id Identifier to read.
   * @param pickupOrder Pickup index a newly created row records.
   * @returns Its row.
   */
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

  /**
   * Records one handler-level outcome against the hook's row, the
   * totals, the subscriber's row and the reporter.
   *
   * @param hook Hook being dispatched.
   * @param id Identifier of the subscriber the outcome belongs to.
   * @param outcome Outcome to record.
   */
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

  /**
   * Records one skipped handler.
   *
   * @param hook Hook being dispatched.
   * @param id Identifier of the subscriber that was skipped.
   * @param reason The reason recorded for the skip.
   */
  const noteSkip = (
    hook: HookName,
    id: string,
    reason: HookSkipReason,
  ): void => {
    note(hook, id, SKIP_OUTCOME[reason]);
  };

  /**
   * Marks a registration degraded and hands the caught value to the
   * reporter.
   *
   * The only `catch` in the retired sources,
   * js/local_storage_manager.js L32-L39, discarded its error; the value
   * caught here is carried into the report as it was thrown.
   *
   * @param registration Registration whose handler threw.
   * @param hook Hook being dispatched.
   * @param error The caught value.
   */
  const noteThrow = (
    registration: Registration,
    hook: HookName,
    error: unknown,
  ): void => {
    registration.degraded = true;

    const id = registration.subscriber.id;

    if (reporter.onHookError !== undefined) {
      deliver((): void => {
        reporter.onHookError?.({ runId, hook, subscriberId: id, error });
      });
    }

    note(hook, id, 'failed');
  };

  /**
   * Finds the registration held under one identifier.
   *
   * @param id Identifier to find.
   * @returns Its registration, or `undefined` when none is held.
   */
  const findRegistration = (id: string): Registration | undefined =>
    registrations.find(
      (registration): boolean => registration.subscriber.id === id,
    );

  /**
   * Reads the registrations in pickup order.
   *
   * The pickup index is the ordering authority; the position a
   * registration holds in the backing array is not.
   *
   * @returns A fresh array on each call.
   */
  const ordered = (): Registration[] =>
    registrations.slice().sort(byPickupOrder);

  /**
   * Collects the identifiers of the registrations marked degraded, in
   * pickup order.
   *
   * @returns A fresh array on each call.
   */
  const collectDegraded = (): string[] => {
    const ids: string[] = [];

    for (const registration of ordered()) {
      if (registration.degraded) {
        ids.push(registration.subscriber.id);
      }
    }

    return ids;
  };

  /**
   * Builds the subscription a registration presents for one hook.
   *
   * `charges` and `state` are read from the subscriber at call time.
   *
   * @param registration Registration to read.
   * @param hook Hook to resolve.
   * @returns The subscription, or `null` where the subscriber binds no
   *   callable handler for that hook.
   */
  const subscriptionFor = <K extends HookName>(
    registration: Registration,
    hook: K,
  ): HookSubscription<K> | null => {
    const handler: unknown = registration.subscriber.hooks[hook];

    if (!isHandler(handler)) {
      return null;
    }

    return {
      subscriberId: registration.subscriber.id,
      pickupOrder: registration.pickupIndex,
      handler: handler as HookHandler<K>,
      charges: registration.subscriber.charges,
      state: registration.subscriber.state,
    };
  };

  return Object.freeze({
    register(subscriber: HookSubscriber): boolean {
      const id: unknown = subscriber.id;

      // Ported from js/keyboard_input_manager.js L18-L23, which pushed
      // onto the array keyed by event name. The four checks below, the
      // pickup index and the counters have no vanilla source.
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

      registrations.push({
        subscriber,
        pickupIndex,
        sequence: nextSequence,
        degraded: false,
        removed: false,
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
      const index = registrations.findIndex(
        (registration): boolean => registration.subscriber.id === id,
      );

      if (index < 0) {
        return false;
      }

      const registration = registrations[index];

      registrations.splice(index, 1);
      registration.removed = true;
      removedSubscribers += 1;
      count(REMOVED_METRIC);

      return true;
    },

    dispatch<K extends HookName>(
      hook: K,
      payload: HookPayloadMap[K],
      environment: HookEnvironment,
    ): HookDispatchResult<K> {
      // Ported from js/keyboard_input_manager.js L25-L32, which read the
      // callbacks for the name and invoked each one inline with a single
      // argument. The pickup ordering, the charge guard, the error
      // isolation, the compounding return and the counters below have no
      // vanilla source.
      hookRow(hook).dispatched += 1;
      totals.dispatched += 1;
      count(DISPATCH_METRIC, hook);

      let accumulated = payload;
      let invoked = 0;
      let skipped = 0;
      let failed = 0;
      let rejected = 0;

      // Order and membership are read once, ahead of the walk. A
      // registration added during the walk is reached by the next
      // dispatch; one removed during it is skipped by this one.
      const walking = ordered();

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
          config: environment.config,
          rng: environment.rng,
          grid: environment.grid,
          runId,
          hook,
          subscriberId: id,
          pickupOrder: subscription.pickupOrder,
          charges,
          state: subscription.state,
        };

        invoked += 1;
        note(hook, id, 'invoked');

        try {
          const returned: unknown = subscription.handler(
            accumulated,
            context,
          );

          if (returned !== undefined && returned !== null) {
            if (isPayloadLike(returned)) {
              accumulated = returned as HookPayloadMap[K];
            } else {
              rejected += 1;
              note(hook, id, 'rejected');
            }
          }
        } catch (error: unknown) {
          failed += 1;
          noteThrow(registration, hook, error);
        }

        // The context's state slot is written back onto the subscriber.
        registration.subscriber.state = context.state;
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
      // Extension with no vanilla source, and the one path that writes
      // `charges`.
      const registration = findRegistration(id);

      if (registration === undefined) {
        return UNHELD_CONSUMPTION;
      }

      const subscriber = registration.subscriber;

      if (subscriber.charges === undefined) {
        return UNLIMITED_CONSUMPTION;
      }

      const available = normaliseCharges(subscriber.charges);
      const taken = Math.min(available, normaliseCharges(amount));
      const remaining = available - taken;

      subscriber.charges = remaining;

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
      // Extension with no vanilla source.
      return Object.freeze(collectDegraded());
    },

    subscriptions<K extends HookName>(
      hook: K,
    ): readonly HookSubscription<K>[] {
      // Extension with no vanilla source.
      const resolved: HookSubscription<K>[] = [];

      for (const registration of ordered()) {
        const subscription = subscriptionFor(registration, hook);

        if (subscription !== null) {
          resolved.push(subscription);
        }
      }

      return Object.freeze(resolved);
    },

    subscribers(): readonly HookSubscriber[] {
      // Extension with no vanilla source.
      return Object.freeze(
        ordered().map(
          (registration): HookSubscriber => registration.subscriber,
        ),
      );
    },

    metrics(): HookBusMetrics {
      // Extension with no vanilla source. The per-hook record is built
      // from HOOK_NAMES, and the subscriber rows are ordered by pickup
      // index and then by first registration.
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
        runId,
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

