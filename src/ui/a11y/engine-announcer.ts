// Translates engine events into live-region announcements.
//
// Provenance:
//   src/ui/a11y/live-region.ts   the announcer, its `Announcement` vocabulary
//                                and `composeAnnouncements`
//   src/engine/engine-events.ts  the seven event names and their payloads
//
// This module is the missing link between the two. `createLiveRegionAnnouncer`
// was fully implemented and fully tested but never constructed, and nothing
// ever fed it, so `#live-region` stayed empty for the whole life of a run: a
// screen-reader user was told nothing about a move, a merge, a spawn or a
// verdict. The announcer knew how to say all of it and was never asked.
//
// Deliberately thin. It performs no composition, no ordering and no
// deduplication of its own, because `composeAnnouncements` already does all
// three — it orders the clauses of one batch as move, merges, spawn, stage,
// score no matter which order they arrived in, drops a move that changed
// nothing, and lets a verdict supersede the gameplay items beside it. Adding a
// second opinion here would fight it.
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
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-ANNOUNCE-01  composition, ordering and deduplication left to
//                   `composeAnnouncements`
//   DL-ANNOUNCE-02  the last verdict announced held here, so a verdict is
//                   announced once per run

import type { EngineEventName, EngineEvents } from '../../engine/engine-events';
import type { AnnouncedDirection, LiveRegionAnnouncer, TerminalVerdict } from './live-region';
import type { UiReporter } from './settings';
import { NOOP_UI_REPORTER, createSafeUiReporter } from './settings';

/* ==========================================================================
 * 1. Reported names
 * ========================================================================== */

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

/* ==========================================================================
 * 2. Types
 * ========================================================================== */

/**
 * The slice of `EngineEvents` this module uses.
 *
 * `on` alone: the translator subscribes and never emits, so the emitting half
 * of the interface is deliberately out of reach. Written as a `Pick` of the
 * real interface rather than a hand-copied signature, so the generic key and
 * payload typing carries over and a rename of an event name is a type error
 * here rather than a listener that is silently never called.
 */
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

  /**
   * The verdict last announced, or `null` where none has been.
   *
   * Exposed so a caller and a test can see the transition state this module
   * keeps, rather than inferring it from the region's text.
   */
  lastVerdict(): TerminalVerdict | null;

  /** Releases every subscription. Calling it more than once is harmless. */
  destroy(): void;
}

/* ==========================================================================
 * 3. Verdict resolution
 * ========================================================================== */

/**
 * Reduces the three terminal flags of a commit to the verdict to announce.
 *
 * The same three-flag reduction the HUD applies to choose an overlay class, and
 * it must agree with it: `over` is a loss, and a win that is still blocked
 * pending acknowledgement is the win itself while a win the player has carried
 * on past is the continued win. `terminated` is the engine's own answer to
 * whether play is blocked, so a continued win resolves without this module
 * tracking the acknowledgement.
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

/* ==========================================================================
 * 4. Construction
 * ========================================================================== */

/**
 * Builds a translator that feeds one announcer from one engine.
 *
 * Nothing is read or written at construction: no subscription exists until
 * `subscribe` is called, and no announcement is made until an event arrives.
 *
 * @param options The announcer to feed and an optional sink.
 * @returns The translator.
 *
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

  /**
   * Direction of the move in flight.
   *
   * Captured from `move:before` because `move:after` does not carry one — it
   * reports what the move did, not which way it went — while a move
   * announcement needs both halves. `move:before` carries the direction the
   * engine will actually resolve in, so a hook that redirected the move is
   * announced as the direction the player got rather than the one they asked
   * for.
   */
  let pendingDirection: AnnouncedDirection | null = null;

  /** The verdict last announced, so a verdict is announced once and not per commit. */
  let lastVerdict: TerminalVerdict | null = null;

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

      const bound: (() => void)[] = [
        events.on('move:before', (payload): void => {
          // Held, not announced: a cancelled move emits no `move:after`, and
          // the next `move:before` overwrites this, so a withdrawn move can
          // never be announced as one that happened.
          pendingDirection = payload.direction;
        }),

        events.on('tile:merge', (payload): void => {
          announcer.announce({
            kind: 'merge',
            resultValue: payload.resultValue,
            scoreDelta: payload.scoreDelta,
          });
          announced('tile:merge');
        }),

        events.on('tile:spawn', (payload): void => {
          // An attempt that inserted nothing carries no position: the full
          // board of AAP Contract 1, a suppressing `onSpawn` handler, or a
          // handler that named a cell off the lattice. There is no tile to
          // narrate, so nothing is announced.
          if (payload.position === undefined) {
            return;
          }

          announcer.announce({
            kind: 'spawn',
            value: payload.value,
            position: payload.position,
          });
          announced('tile:spawn');
        }),

        events.on('move:after', (payload): void => {
          if (pendingDirection === null) {
            // No direction was captured, so this move did not come through
            // `move:before` in this subscription's lifetime. Announcing a
            // direction would mean inventing one.
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
        }),

        events.on('stage:end', (payload): void => {
          announcer.announce({
            kind: 'stageClear',
            stageIndex: payload.stageIndex,
            cleared: payload.cleared,
          });
          announced('stage:end');
        }),

        events.on('state:commit', (payload): void => {
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
        }),
      ];

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

        for (const release of bound) {
          release();

          const index = releases.indexOf(release);

          if (index >= 0) {
            releases.splice(index, 1);
          }
        }
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
    },
  });
}
