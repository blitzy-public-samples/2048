// The hook bus: pickup-order dispatch of the six engine hooks.
//
// Supersedes the three-name publish/subscribe bus of
// js/keyboard_input_manager.js L18-L32, which appended callbacks to an
// array keyed by event name and invoked them inline in registration
// order with no queue, no error isolation and no return value. This bus
// keeps the append-and-invoke-inline shape and adds four properties:
//
//   pickup order      registration order is pickup order, and dispatch
//                     walks it from index 0 on every hook.
//   charge guard      a subscriber carrying `charges` at or below zero
//                     is skipped before its handler is reached, so the
//                     guard is implemented once here rather than once
//                     per subscriber.
//   error isolation   a handler that throws is caught, reported, and its
//                     subscriber is marked degraded and skipped from
//                     then on. The dispatch continues and the turn
//                     completes.
//   compounding       each handler receives the payload the previous
//                     handler returned, so effects chain rather than
//                     overwrite.
//
// Invariants of this module: it names no engine module other than
// ./hooks and ./types, reads no DOM, performs no I/O, consumes no
// randomness and reads no clock.
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
import type { EngineReporter } from './types';
import { NOOP_ENGINE_REPORTER } from './types';

/* --------------------------------------------------------------------------
 * Counter names
 * ----------------------------------------------------------------------- */

/** Counter name for one hook dispatch. */
const DISPATCH_METRIC = 'engine.hook.dispatch';

/** Counter name for one handler invocation. */
const HANDLER_METRIC = 'engine.hook.handler';

/** Counter name for a handler skipped by the charge guard. */
const EXHAUSTED_METRIC = 'engine.hook.exhausted';

/** Counter name for a handler skipped because its subscriber degraded. */
const DEGRADED_METRIC = 'engine.hook.degraded';

/** Counter name for a handler that threw. */
const HANDLER_ERROR_METRIC = 'engine.hook.error';

/** Counter name for a rejected registration. */
const INVALID_SUBSCRIBER_METRIC = 'engine.hook.subscriber.invalid';

/* --------------------------------------------------------------------------
 * Registration contract
 * ----------------------------------------------------------------------- */

/**
 * What is registered on the bus.
 *
 * This is the behavioural slice of the relic data shape: `id`, the
 * `hooks` handler table, and the optional `charges` and `state`. A relic
 * is registered by handing its own object here, and the bus reads no
 * member beyond these four.
 */
export interface HookSubscriber {
  /**
   * Identifier, carried into every report and into the dispatch
   * context. Registering a second subscriber under an identifier
   * already held is rejected.
   */
  readonly id: string;

  /** Handlers this subscriber binds, keyed by hook name. */
  readonly hooks: HookHandlerTable;

  /**
   * Remaining charges. Absent on a subscriber with no charge budget,
   * which is never charge-guarded. Present and at or below zero, every
   * handler is skipped.
   */
  charges?: number;

  /** Subscriber-owned state. Neither read nor written by the bus. */
  state?: unknown;
}

/**
 * A registration, as the bus holds it.
 *
 * `pickupIndex` is assigned at registration and never reassigned, so a
 * subscriber's position survives the removal of an earlier one.
 */
interface Registration {
  readonly subscriber: HookSubscriber;
  readonly pickupIndex: number;
  degraded: boolean;
}

/** Why a subscriber's handler was not invoked. */
export type HookSkipReason = 'exhausted' | 'degraded';

/**
 * One hook's dispatch outcome.
 *
 * Returned by `dispatch` alongside the payload so a caller can act on
 * what happened without subscribing to the reporter.
 */
export interface HookDispatchResult<K extends HookName> {
  /** The payload after every handler that ran. */
  readonly payload: HookPayloadMap[K];

  /** Handlers that were invoked. */
  readonly invoked: number;

  /** Handlers skipped by the charge guard or the degraded guard. */
  readonly skipped: number;

  /** Handlers that threw and were contained. */
  readonly failed: number;
}

/**
 * The bus.
 *
 * Frozen: the four members below are its whole surface.
 */
export interface HookBus {
  /**
   * Registers a subscriber at the end of pickup order.
   *
   * @param subscriber Subscriber to register.
   * @returns `true` when it was registered, `false` when its
   *   identifier is already held or its handler table is unusable.
   */
  register(subscriber: HookSubscriber): boolean;

  /**
   * Removes a subscriber.
   *
   * @param id Identifier the subscriber was registered under.
   * @returns `true` when a registration was removed.
   */
  unregister(id: string): boolean;

  /**
   * Dispatches one hook to every subscriber bound to it, in pickup
   * order.
   *
   * @param hook Hook to dispatch.
   * @param payload Payload the first handler receives.
   * @param environment The live rules, substreams and board, supplied
   *   per dispatch so each handler reads the instance in force.
   * @returns The accumulated payload and the dispatch's counts.
   */
  dispatch<K extends HookName>(
    hook: K,
    payload: HookPayloadMap[K],
    environment: HookEnvironment,
  ): HookDispatchResult<K>;

  /**
   * Reads the subscriptions bound to one hook, in pickup order.
   *
   * Extension with no vanilla source.
   *
   * @param hook Hook to resolve.
   * @returns A fresh array each call, ordered by `pickupOrder`. The
   *   `charges` and `state` members are the subscriber's values as at
   *   the moment of the call.
   */
  subscriptions<K extends HookName>(
    hook: K,
  ): readonly HookSubscription<K>[];

  /**
   * Reads the registered subscribers in pickup order.
   *
   * @returns A fresh array each call. Mutating it does not affect the
   *   bus; the subscriber objects are the registered ones.
   */
  subscribers(): readonly HookSubscriber[];
}

/** Construction parameters. */
export interface HookBusOptions {
  /**
   * Correlation identifier of the run, carried into every report and
   * every dispatch context. Defaults to the empty string.
   */
  readonly runId?: string;

  /** Sink for caught handler errors and counters. */
  readonly reporter?: EngineReporter;
}

/* --------------------------------------------------------------------------
 * Construction
 * ----------------------------------------------------------------------- */

/**
 * Reports whether a handler table carries at least one callable
 * handler and nothing that is neither callable nor absent.
 *
 * @param hooks Table to validate.
 * @returns `true` when every present entry is callable and at least one
 *   is present.
 */
function isUsableTable(hooks: HookHandlerTable): boolean {
  let bound = 0;

  for (const value of Object.values(hooks)) {
    if (value === undefined) {
      continue;
    }

    if (typeof value !== 'function') {
      return false;
    }

    bound += 1;
  }

  return bound > 0;
}

/**
 * Creates a hook bus.
 *
 * @param options Correlation identifier and report sink. Both optional.
 * @returns A frozen bus.
 *
 * @example
 * ```ts
 * const bus = createHookBus({ runId, reporter });
 *
 * bus.register({
 *   id: 'double-spawn',
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

  /** Registrations, in pickup order. */
  const registrations: Registration[] = [];

  /** Identifiers already held, so a duplicate is rejected. */
  const held = new Set<string>();

  let nextPickupIndex = 0;

  /**
   * Reads the registrations ordered by pickup index.
   *
   * The index is the ordering authority, not the position a
   * registration happens to hold in the backing array.
   *
   * @returns A fresh array each call.
   */
  const orderedRegistrations = (): Registration[] =>
    registrations
      .slice()
      .sort((left, right) => left.pickupIndex - right.pickupIndex);

  /**
   * Builds the subscription a registration presents for one hook.
   *
   * `charges` and `state` are read from the subscriber at call time, so
   * the returned record carries the values in force.
   *
   * @param registration Registration to read.
   * @param hook Hook to resolve.
   * @returns The subscription, or `null` when the subscriber binds no
   *   handler for that hook.
   */
  const subscriptionFor = <K extends HookName>(
    registration: Registration,
    hook: K,
  ): HookSubscription<K> | null => {
    const handler = registration.subscriber.hooks[hook] as
      | HookHandler<K>
      | undefined;

    if (handler === undefined) {
      return null;
    }

    return {
      subscriberId: registration.subscriber.id,
      pickupOrder: registration.pickupIndex,
      handler,
      charges: registration.subscriber.charges,
      state: registration.subscriber.state,
    };
  };

  /**
   * Adds to a counter.
   *
   * @param metric Counter name.
   * @param hook Hook the count belongs to, where it has one.
   */
  const count = (metric: string, hook?: HookName): void => {
    reporter.onCount?.({ runId, metric, value: 1, hook });
  };

  /**
   * Reports a skipped handler.
   *
   * @param hook Hook being dispatched.
   * @param reason Why the handler was skipped.
   */
  const reportSkip = (hook: HookName, reason: HookSkipReason): void => {
    count(reason === 'exhausted' ? EXHAUSTED_METRIC : DEGRADED_METRIC, hook);
  };

  /**
   * Reports a handler that threw and marks its subscriber degraded.
   *
   * @param registration Registration whose handler threw.
   * @param hook Hook being dispatched.
   * @param error The caught value, exactly as thrown.
   */
  const reportThrow = (
    registration: Registration,
    hook: HookName,
    error: unknown,
  ): void => {
    registration.degraded = true;

    reporter.onHookError?.({
      runId,
      hook,
      subscriberId: registration.subscriber.id,
      error,
    });
    count(HANDLER_ERROR_METRIC, hook);
  };

  return Object.freeze({
    register(subscriber: HookSubscriber): boolean {
      if (
        typeof subscriber.id !== 'string' ||
        subscriber.id.length === 0 ||
        held.has(subscriber.id) ||
        !isUsableTable(subscriber.hooks)
      ) {
        count(INVALID_SUBSCRIBER_METRIC);

        return false;
      }

      held.add(subscriber.id);
      registrations.push({
        subscriber,
        pickupIndex: nextPickupIndex,
        degraded: false,
      });
      nextPickupIndex += 1;

      return true;
    },

    unregister(id: string): boolean {
      if (!held.delete(id)) {
        return false;
      }

      for (let index = 0; index < registrations.length; index += 1) {
        if (registrations[index].subscriber.id === id) {
          registrations.splice(index, 1);

          return true;
        }
      }

      return false;
    },

    dispatch<K extends HookName>(
      hook: K,
      payload: HookPayloadMap[K],
      environment: HookEnvironment,
    ): HookDispatchResult<K> {
      count(DISPATCH_METRIC, hook);

      let accumulated = payload;
      let invoked = 0;
      let skipped = 0;
      let failed = 0;

      // Snapshotted before the walk, so a handler that registers or
      // unregisters a subscriber cannot alter this dispatch's order or
      // membership. It takes effect on the next dispatch.
      const walking = orderedRegistrations();

      for (const registration of walking) {
        const subscription = subscriptionFor(registration, hook);

        if (subscription === null) {
          continue;
        }

        if (registration.degraded) {
          skipped += 1;
          reportSkip(hook, 'degraded');

          continue;
        }

        const charges = subscription.charges;

        // The charge guard. A subscriber with no `charges` member is
        // never guarded; one carrying a value at or below zero is
        // skipped without its handler being reached, which is what
        // makes a zero-charge invocation throw nothing.
        if (charges !== undefined && charges <= 0) {
          skipped += 1;
          reportSkip(hook, 'exhausted');

          continue;
        }

        const context: HookContext = {
          config: environment.config,
          rng: environment.rng,
          grid: environment.grid,
          runId,
          hook,
          subscriberId: subscription.subscriberId,
          pickupOrder: subscription.pickupOrder,
          charges,
          state: subscription.state,
        };

        invoked += 1;
        count(HANDLER_METRIC, hook);

        try {
          const returned = subscription.handler(accumulated, context);

          if (returned !== undefined && returned !== null) {
            accumulated = returned;
          }
        } catch (error: unknown) {
          failed += 1;
          reportThrow(registration, hook, error);
        }

        // The state slot belongs to the subscriber and the context is
        // where a handler assigns it, so the value is carried back.
        registration.subscriber.state = context.state;
      }

      return Object.freeze({
        payload: accumulated,
        invoked,
        skipped,
        failed,
      });
    },

    subscriptions<K extends HookName>(
      hook: K,
    ): readonly HookSubscription<K>[] {
      const resolved: HookSubscription<K>[] = [];

      for (const registration of orderedRegistrations()) {
        const subscription = subscriptionFor(registration, hook);

        if (subscription !== null) {
          resolved.push(subscription);
        }
      }

      return resolved;
    },

    subscribers(): readonly HookSubscriber[] {
      return registrations.map(
        (registration): HookSubscriber => registration.subscriber,
      );
    },
  });
}
