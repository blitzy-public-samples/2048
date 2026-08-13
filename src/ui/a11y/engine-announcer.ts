// Translates engine events into live-region announcements.
//
// Provenance: src/ui/a11y/live-region.ts the announcer, its `Announcement`
// vocabulary and `composeAnnouncements` src/engine/engine-events.ts the seven
// event names and their payloads
//
// The one piece of state it does keep is the last verdict announced:
// `state:commit` fires on every commit while a verdict is news exactly once.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated, all target-only because the retired sources
// announced nothing:
//   TR-ANNOUNCE-01  `createEngineAnnouncer` and its subscription to the seven
//                   event names
//   TR-ANNOUNCE-02  the per-event translation into the `Announcement`
//                   vocabulary of ./live-region
//   TR-ANNOUNCE-03  the last-verdict record and the once-per-verdict rule
//   TR-ANNOUNCE-04  `EngineAnnouncer.dispose` and the released subscriptions
//   TR-ANNOUNCE-05  the unconfirmed-status announcement, spoken on each
//                   transition of `StateCommitEvent.degraded` in both
//                   directions
//
// Decisions: DL-ANNOUNCE-01, DL-ANNOUNCE-02, DL-ANNOUNCE-03
//   (docs/DECISION_LOG.md).

import type { EngineEventName, EngineEvents } from '../../engine/engine-events';
import type { AnnouncedDirection, LiveRegionAnnouncer, TerminalVerdict } from './live-region';
import type { UiReporter } from './settings';
import { NOOP_UI_REPORTER, createSafeUiReporter } from './settings';

/** Context every report of this module carries. */
const REPORT_CONTEXT = 'a11y-engine-announcer';

/** Counter raised once per subscription. */
const SUBSCRIBE_METRIC = 'ui.announcer.subscribe';

/** Counter raised once per announcement handed to the announcer. */
const ANNOUNCE_METRIC = 'ui.announcer.translated';

/** Counter raised once per verdict transition announced. */
const VERDICT_METRIC = 'ui.announcer.verdict';

/** Counter raised once per subscription refused. */
const REFUSED_METRIC = 'ui.announcer.refused';

/** Counter raised once per unconfirmed-status transition announced. */
const DEGRADED_METRIC = 'ui.announcer.degraded';

/**
 * Spoken when a commit reports that the engine could not establish the turn's
 * terminal or stage status.
 */
const DEGRADED_ANNOUNCEMENT =
  'Board status unconfirmed. The game could not check for a win, a loss or a ' +
  'cleared stage on this move.';

/** Spoken when a later commit establishes the status again. */
const CONFIRMED_ANNOUNCEMENT = 'Board status confirmed again.';

/** The slice of `EngineEvents` this module uses. */
export type AnnouncedEngineEvents = Pick<EngineEvents, 'on'>;

/** What `createEngineAnnouncer` accepts. */
export interface EngineAnnouncerOptions {
  /** The announcer to feed. */
  readonly announcer: LiveRegionAnnouncer;

  /** Contained sink for this module's own reports. */
  readonly reporter?: UiReporter;
}

/** The translator a caller holds. */
export interface EngineAnnouncer {
  /**
   * Subscribes to an engine's events.
   *
   * @param events The engine's event emitter.
   * @returns A release function. Calling it more than once is harmless.
   */
  subscribe(events: AnnouncedEngineEvents): () => void;

  /** The verdict last announced, or `null` where none has been. */
  lastVerdict(): TerminalVerdict | null;

  /** Releases every subscription. Calling it more than once is harmless. */
  destroy(): void;
}

/**
 * Reduces the three terminal flags of a commit to the verdict to announce.
 *
 * @param over Whether the run is lost.
 * @param won Whether the configured win value has been reached.
 * @param terminated Whether play is blocked pending an acknowledgement.
 * @returns The verdict, or `null` where the run is still in play.
 */
function resolveVerdict(
  over: boolean,
  won: boolean,
  terminated: boolean,
): TerminalVerdict | null {
  if (over) {
    return 'loss';
  }

  if (!won) {
    return null;
  }

  return terminated ? 'win' : 'continued-win';
}

/**
 * Builds a translator that feeds one announcer from one engine.
 *
 * Nothing is read or written at construction: no subscription exists until
 * `subscribe` is called, and no announcement is made until an event arrives.
 *
 * @param options The announcer to feed and an optional sink.
 * @returns The translator.
 * @example
 * const announcer = createLiveRegionAnnouncer({ root: document });
 * const translator = createEngineAnnouncer({ announcer });
 * const release = translator.subscribe(engine.events);
 */
export function createEngineAnnouncer(
  options: EngineAnnouncerOptions,
): EngineAnnouncer {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const announcer = options.announcer;

  const releases: (() => void)[] = [];

  let destroyed = false;

  /** Direction of the move in flight. */
  let pendingDirection: AnnouncedDirection | null = null;

  /**
   * The verdict last announced, so a verdict is announced once and not per
   * commit.
   */
  let lastVerdict: TerminalVerdict | null = null;

  /**
   * Whether the last commit reported an unestablished status, so the
   * transition is announced and the state is not repeated on every commit that
   * follows it.
   */
  let lastDegraded = false;

  const announced = (name: EngineEventName): void => {
    reporter.count(ANNOUNCE_METRIC, { context: REPORT_CONTEXT, event: name });
  };

  return Object.freeze({
    subscribe(events: AnnouncedEngineEvents): () => void {
      if (destroyed) {
        reporter.count(REFUSED_METRIC, {
          context: REPORT_CONTEXT,
          reason: 'destroyed',
        });

        return (): void => {
          return;
        };
      }

      const bound: (() => void)[] = [];

      /**
       * Records one release AS IT IS TAKEN.
       *
       * ADDED: the six were taken in one array literal, so a refusal from a
       * later `on()` discarded the half-built array and left every listener
       * before it attached to the emitter with no reference to it anywhere —
       * the announcer went on announcing for a subscription it had reported it
       * did not hold, unreachable by `destroy()` or the returned release.
       * DL-ANNOUNCE-03.
       *
       * @param release The release the emitter returned.
       */
      const hold = (release: () => void): void => {
        bound.push(release);
      };

      /** Releases everything held, whichever release refuses. */
      const releaseBound = (): void => {
        let raised: unknown = null;
        let failed = false;

        for (const release of bound) {
          try {
            release();
          } catch (error: unknown) {
            if (!failed) {
              failed = true;
              raised = error;
            }
          }

          const index = releases.indexOf(release);

          if (index >= 0) {
            releases.splice(index, 1);
          }
        }

        if (failed) {
          throw raised;
        }
      };

      try {
        hold(events.on('move:before', (payload): void => {
          // Held, not announced: a cancelled move emits no `move:after`, and
          // the next `move:before` overwrites this, so a withdrawn move can
          // never be announced as one that happened.
          pendingDirection = payload.direction;
        }));

        hold(events.on('tile:merge', (payload): void => {
          announcer.announce({
            kind: 'merge',
            resultValue: payload.resultValue,
            scoreDelta: payload.scoreDelta,
          });
          announced('tile:merge');
        }));

        hold(events.on('tile:spawn', (payload): void => {
          // An attempt that inserted nothing carries no position: the full
          // board of AAP Contract 1, a suppressing `onSpawn` handler, or a
          // handler that named a cell off the lattice.
          if (payload.position === undefined) {
            return;
          }

          announcer.announce({
            kind: 'spawn',
            value: payload.value,
            position: payload.position,
          });
          announced('tile:spawn');
        }));

        hold(events.on('move:after', (payload): void => {
          if (pendingDirection === null) {
            // No direction was captured, so this move did not come through
            // `move:before` in this subscription's lifetime.
            return;
          }

          announcer.announce({
            kind: 'move',
            direction: pendingDirection,
            changed: payload.moved,
            score: payload.score,
          });
          announced('move:after');
          pendingDirection = null;
        }));

        hold(events.on('stage:end', (payload): void => {
          announcer.announce({
            kind: 'stageClear',
            stageIndex: payload.stageIndex,
            cleared: payload.cleared,
          });
          announced('stage:end');
        }));

        hold(events.on('state:commit', (payload): void => {
          // The unconfirmed status is announced on its transitions, both of
          // them: a commit whose terminal or stage status the engine could not
          // establish, and the commit that establishes one again.
          if (payload.degraded !== lastDegraded) {
            lastDegraded = payload.degraded;

            announcer.announce({
              kind: 'text',
              text: payload.degraded
                ? DEGRADED_ANNOUNCEMENT
                : CONFIRMED_ANNOUNCEMENT,
            });
            reporter.count(DEGRADED_METRIC, {
              context: REPORT_CONTEXT,
              degraded: payload.degraded,
            });
          }

          const verdict = resolveVerdict(
            payload.over,
            payload.won,
            payload.terminated,
          );

          if (verdict === lastVerdict) {
            // Every commit carries the terminal flags, so without this a won
            // run would announce its verdict again on every later move.
            return;
          }

          lastVerdict = verdict;

          if (verdict === null) {
            return;
          }

          announcer.announce({
            kind: 'terminal',
            verdict,
            score: payload.score,
          });
          reporter.count(VERDICT_METRIC, {
            context: REPORT_CONTEXT,
            verdict,
          });
        }));
      } catch (error: unknown) {
        // Rolled back and rethrown, so the emitter is exactly as it was and
        // the same call can simply be retried. DL-ANNOUNCE-03.
        try {
          releaseBound();
        } catch {
          // A release that refuses during a rollback is contained: the
          // registration failure is the one the caller has to act on.
        }

        bound.length = 0;
        reporter.count(REFUSED_METRIC, {
          context: REPORT_CONTEXT,
          reason: 'registering',
        });

        throw error;
      }

      releases.push(...bound);
      reporter.count(SUBSCRIBE_METRIC, {
        context: REPORT_CONTEXT,
        events: bound.length,
      });

      let released = false;

      return (): void => {
        if (released) {
          return;
        }

        released = true;

        // CHANGED: every listener is released and every entry removed from
        // the shared list whichever release refuses. The loop stopped at the
        // first refusal, stranding the rest attached AND listed — so
        // `destroy()` then called them a second time. DL-ANNOUNCE-03.
        releaseBound();
      };
    },

    lastVerdict(): TerminalVerdict | null {
      return lastVerdict;
    },

    destroy(): void {
      if (destroyed) {
        return;
      }

      destroyed = true;

      for (const release of releases) {
        release();
      }

      releases.length = 0;
      pendingDirection = null;
      lastDegraded = false;
    },
  });
}
