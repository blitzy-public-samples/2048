// The in-run heads-up display: the `stage` state of src/ui/screen-router.ts,
// and the only screen live while a board is being played.
//
// WHAT IT OWNS
//   the score and best-score outlets `.score-container` and `.best-container`,
//   through `ScorePanel`;
//   the stage indicator in `#hud-stage`: the stage number, the goal readout and
//   the live board dimension;
//   the active-relic tray in `#relic-tray`, one `createRelicTrayItem` row per
//   held relic in the order supplied;
//   the `.game-message` overlay: the two state classes js/html_actuator.js
//   L131-L133 toggled and the verdict text L129 wrote;
//   the unconfirmed-status notice `.hud-degraded` and the `data-degraded` flag
//   on the run-status group;
//   the run-not-saved notice `.hud-ephemeral` and the `data-ephemeral` flag on
//   the same group, and the `data-degraded` marker on the tray row of a relic
//   the hook bus has stopped firing — the two FAILURE STATES the run can be in
//   while it is still playable.
//
// WHAT IT DOES NOT OWN
//   the two score writes themselves. `updateScore` and `updateBestScore` of
//   js/html_actuator.js L106-L125 map to src/ui/components/score-panel.ts,
//   which owns the `+N` `.score-addition` node and the real accessible names;
//   this module calls that component and restates none of it;
//   the tray row's element tree, built by src/ui/components/relic-card.ts;
//   every element-to-action binding: `.restart-button`, `.retry-button`,
//   `.keep-playing-button`, the direction pad and the relic tray control
//   all belong to src/input/on-screen-controls.ts and are hosted here, never
//   bound here;
//   the engine subscription. A payload arrives from the host: a commit
//   through `render`, a router context through `enter` and `update`, and this
//   module subscribes to no emitter;
//   pickup order, stage-goal evaluation, charge budgets and board size, each
//   read as supplied and none recomputed here;
//   focus placement and the entry announcement in a composition that supplies
//   `focusContainer: null`, which src/main.ts does: src/ui/screen-router.ts
//   places focus for every state and reads the entry line, which this module
//   supplies through `announcement()`.
//
// PORTED BEHAVIOUR
//   js/html_actuator.js L24-L25    the write order: the score, then the best
//                                  score
//   js/html_actuator.js L26-L33    the overlay decided last, from the terminal
//                                  flags alone, with the loss taking precedence
//   js/html_actuator.js L127-L132  message(won): 'game-won' or 'game-over',
//                                  then the verdict into the overlay paragraph
//   js/html_actuator.js L129       the two verdict strings, verbatim
//   js/html_actuator.js L135-L139  clearMessage(): both classes removed
//   js/game_manager.js L95         the best score rendered from the payload,
//                                  which is the value re-read from storage
//   style/main.scss L103, L205     the z-index ceiling of 100, extended through
//                                  `zIndex.hud` of ../../theme/tokens
//
// Every lookup is guarded through `resolveMount`: none of the eight selectors
// of the vanilla markup was null-checked, so a renamed class was a startup
// failure (I12).
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece. THAT DOCUMENT HAS
// NOT LANDED: the ordinals below are RESERVED against it, not resolvable today.
// HUD is one area across the TypeScript and stylesheet halves, so the ordinals
// are unique across this module and style/_hud.scss:
//   TR-HUD-01  js/html_actuator.js L24-L27    the write order of `actuate()`:
//                                             score, best score, message
//   TR-HUD-02  js/html_actuator.js L127-L131  `message(won)` and its two state
//                                             classes
//   TR-HUD-03  js/html_actuator.js L129       the two verdict strings, verbatim
//   TR-HUD-04  js/html_actuator.js L135-L139  `clearMessage()`, both classes
//                                             removed
//   TR-HUD-05  target-only row                `createHud()`, `HudSnapshot` and
//                                             the guarded lookups
//   TR-HUD-06  target-only row                the stage number, the goal
//                                             readout and the live board
//                                             dimension
//   TR-HUD-12  target-only row                the unconfirmed-status notice:
//                                             `.hud-degraded`, its hidden
//                                             state and `data-degraded` on the
//                                             run-status group
//   TR-HUD-13  target-only row                the per-relic tier and budget
//                                             metadata the tray row carries
//   TR-HUD-15  target-only row                the `Screen` lifecycle —
//                                             `mount`, `enter`, `update`,
//                                             `leave`, `unmount` — and the
//                                             in-place tray reconciliation
//   TR-HUD-16  target-only row                the live-region charge-change and
//                                             relic-acquisition announcements
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-HUD-01  the HUD as the sole writer of the score, best-score and terminal
//              overlay outlets, outside every renderer
//   DL-HUD-02  every value arriving on a payload, with no engine state read
//              here
//   DL-HUD-03  the two verdict strings carried verbatim from the retired
//              actuator
//   DL-HUD-07  `leave()` deactivating rather than tearing down, with the full
//              teardown in `unmount()`
//   DL-HUD-08  the acquisition announcement opt-in and the charge-change
//              announcement always on
//   DL-HUD-09  the commit push retained beside the router lifecycle, and the
//              score write skipped for an unchanged context refresh
//   DL-HUD-10  the goal track decorative rather than a `role="progressbar"`
//   DL-HUD-11  the entry line supplied to the router through `announcement()`
//   DL-HUD-12  focus placement opted out of through `focusContainer: null` in
//              the composed root
//   DL-HUD-15  the run-not-saved line written assertively while the recovery
//              line stays polite, and the notice element itself taking no
//              `role="alert"`
//
// Nothing is read or written at import time: every lookup, every report and
// every DOM write happens inside a call.
//
// Decisions: DL-HUD-01, DL-HUD-02, DL-HUD-03, DL-HUD-07, DL-HUD-08, DL-HUD-09,
// DL-HUD-10, DL-HUD-15 (docs/DECISION_LOG.md).

import type { StageGoal } from '../../config/stage-config';
import type { StateCommitEvent } from '../../engine/engine-events';
import type {
  BestScoreValue,
  RelicCommitContext,
  RelicCommitEntry,
} from '../../engine/types';
import type { ActiveRelic, Rarity } from '../../relics/relic-types';
import { zIndex } from '../../theme/tokens';
import type { ScreenName as FocusScreenName } from '../a11y/focus-manager';
import { focusInitial } from '../a11y/focus-manager';
import type {
  AnnouncementPolarity,
  LiveRegionAnnouncer,
} from '../a11y/live-region';

// CHANGED: a value import beside the type imports, for the one line this screen
// writes assertively. DL-HUD-15.
import { ASSERTIVE_POLARITY } from '../a11y/live-region';
import type { UiReporter } from '../a11y/settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from '../a11y/settings';
import type { RelicTrayItem } from '../components/relic-card';
import {
  createRelicTrayItem,
  relicCardClasses,
} from '../components/relic-card';
import type { ScorePanel } from '../components/score-panel';
import { createScorePanel } from '../components/score-panel';
import type { Screen, ScreenContext } from '../screen-router';

/* ==========================================================================
 * 1. Selectors, classes, attributes and copy
 * ========================================================================== */

/** Selector of the terminal overlay. index.html. */
const MESSAGE_SELECTOR = '.game-message';

/** Selector of the overlay's verdict element, for the report on a miss. */
const VERDICT_SELECTOR = '.game-message > p';

/** The verdict element, resolved inside the overlay this module holds. */
const SCOPED_VERDICT_SELECTOR = ':scope > p';

/** Overlay state class of a won board. js/html_actuator.js L128. */
const WON_CLASS = 'game-won';

/** Overlay state class of a lost board. js/html_actuator.js L128. */
const OVER_CLASS = 'game-over';

/** Selector of the in-run status group. index.html. */
const HUD_SELECTOR = '#screen-hud';

/** Selector of the stage indicator. index.html. */
const STAGE_SELECTOR = '#hud-stage';

/** Selector of the active-relic tray. index.html. */
const RELIC_TRAY_SELECTOR = '#relic-tray';

/** Selector of the region focus is placed inside on entry. */
const FOCUS_CONTAINER_SELECTOR = '#game-main';

/** The state this screen renders, as ../a11y/focus-manager names it. */
const STAGE_SCREEN = 'stage' as const satisfies FocusScreenName;

/** Class of the unconfirmed-status notice. style/_hud.scss. */
const DEGRADED_CLASS = 'hud-degraded';

/** Class of the run-not-saved notice. style/_hud.scss. */
const EPHEMERAL_CLASS = 'hud-ephemeral';

/** Attribute the run-status group carries while the run is not being saved. */
const EPHEMERAL_ATTRIBUTE = 'data-ephemeral';

/** Attribute the run-status group carries while a status is unestablished. */
const DEGRADED_ATTRIBUTE = 'data-degraded';

/** Class of one readout's label. style/_hud.scss. */
const LABEL_CLASS = 'hud-label';

/** Class of one readout's value. style/_hud.scss. */
const VALUE_CLASS = 'hud-value';

/** Class of the stage-number readout group. style/_hud.scss. */
const STAGE_INDEX_CLASS = 'hud-stage-index';

/** Class of the goal readout group. style/_hud.scss. */
const GOAL_CLASS = 'hud-goal';

/** Class of the board-dimension readout group. style/_hud.scss. */
const BOARD_CLASS = 'hud-board';

/** Class of the goal track. style/_hud.scss. */
const GOAL_METER_CLASS = 'hud-goal-meter';

/** Class of the goal track's fill. style/_hud.scss. */
const GOAL_METER_FILL_CLASS = 'hud-goal-meter-fill';

/**
 * The custom property style/_hud.scss reads for the goal track's fill, as a
 * fraction of the track in the closed interval [0, 1].
 */
const GOAL_FRACTION_PROPERTY = '--hud-goal-fraction';

/** Attribute the empty-state row carries. style/_hud.scss. */
const EMPTY_TRAY_ATTRIBUTE = 'data-relic-empty';

/** Attribute keeping a decorative element out of the accessibility tree. */
const HIDDEN_ATTRIBUTE = 'aria-hidden';

/** Value every boolean ARIA attribute here is written with. */
const ARIA_TRUE = 'true';

/** Logical names the four mounts are reported under. */
const HUD_MOUNT = 'hud';
const STAGE_MOUNT = 'stage';
const RELIC_TRAY_MOUNT = 'relicTray';
const MESSAGE_MOUNT = 'message';
const FOCUS_MOUNT = 'focusContainer';

/** Label naming this module in every report. */
const REPORT_CONTEXT = 'hud';

/**
 * The rung this surface occupies, read from `zIndex` of ../../theme/tokens and
 * declared by `.hud` in style/_hud.scss.
 *
 * The first step of the ladder extension above the retained ceiling of 100,
 * and below `zIndex.diagnosticsOverlay`.
 */
export const HUD_Z_INDEX: number = zIndex.hud;

/** The ids an empty tray reports. */
const EMPTY_RELIC_IDS: readonly string[] = Object.freeze([]);

/** The degraded set of a HUD whose reader is absent or answered nothing. */
const EMPTY_ID_SET: ReadonlySet<string> = new Set<string>();

/** The tier a synthesised declaration carries when none was resolved. */
const UNRESOLVED_RARITY = '';

/** The handler table a synthesised declaration carries. */
const NO_HOOKS = Object.freeze({});

/**
 * Every string this module renders, overridable so a caller can localise it
 * without editing this module.
 *
 * `relicCharges` and `relicRarity` are handed to `createRelicTrayItem` as its
 * `chargesRemaining` and `rarityText`, so one override reaches the tray rows
 * as well as this module.
 */
export const hudCopy = Object.freeze({
  /** js/html_actuator.js L129, verbatim. */
  wonMessage: 'You win!',

  /** js/html_actuator.js L129, verbatim. */
  overMessage: 'Game over!',

  /** Label above the stage number. */
  stageLabel: 'Stage',

  /** Label above the goal readout. */
  goalLabel: 'Goal',

  /** Label above the board dimension. */
  boardLabel: 'Board',

  /** Renders the stage number a zero-based index names. */
  stageValue: (stageIndex: number): string => String(stageIndex + 1),

  /** Renders the goal readout from its kind, target and measured quantity. */
  goalValue: (kind: string, target: number, measured: number): string =>
    kind === 'score-threshold'
      ? `${measured} / ${target} score`
      : `${measured} / ${target} tile`,

  /** Renders the board dimension from the size in force. */
  boardValue: (boardSize: number): string => `${boardSize} × ${boardSize}`,

  /** Label naming the tray for assistive technology. */
  relicTrayLabel: 'Active relics, in pickup order',

  /** Rendered in place of a row while a run holds no relic. */
  relicTrayEmpty: 'No relics yet',

  /** Renders a relic's remaining charge budget. */
  relicCharges: (charges: number): string => `${charges} left`,

  /**
   * Renders a relic's tier for assistive technology, beside the accent
   * style/_hud.scss draws on the row's leading edge.
   */
  relicRarity: (rarity: string): string => `Rarity: ${rarity}`,

  /**
   * The line the router reads on entry to the stage state, composed from the
   * stage number on screen. Decision DL-HUD-11.
   */
  stageAnnouncement: (stage: number | null): string =>
    stage === null
      ? 'Stage. The board is playable.'
      : `Stage ${String(stage)}. The board is playable.`,

  /** Announced when a held relic's remaining budget changed. */
  chargeAnnouncement: (name: string, charges: number): string =>
    `${name}: ${charges} left.`,

  /**
   * Shown while a payload reports `degraded`: the engine could not establish
   * whether the run is lost or the stage is cleared. The once-per-transition
   * announcement is src/ui/a11y/engine-announcer.ts's.
   */
  degradedNotice: 'Board status unconfirmed',

  /**
   * Shown while the run in force is not reaching storage: a write was refused
   * or raised, so the board is played from memory and a reload will not resume
   * it. The player-facing half of a persistence failure, whose diagnostic half
   * src/run/run-state-store.ts reports.
   */
  ephemeralNotice: 'This run is not being saved',

  /** Announced once when the run stops being saved. */
  ephemeralAnnouncement:
    'This run is no longer being saved. It will not resume after a reload.',

  /** Announced once when the run starts being saved again. */
  persistentAnnouncement: 'This run is being saved again.',

  /** Announced once per relic the hook bus stops firing. */
  degradedRelicAnnouncement: (name: string): string =>
    `${name} stopped firing and is no longer affecting the run.`,
});

export type HudCopy = typeof hudCopy;

/* ==========================================================================
 * 2. Report names
 * ========================================================================== */

/** Counter raised once per completed construction. */
const MOUNTED_METRIC = 'ui.hud.mounted';

/** Counter raised once per outlet the document did not supply. */
const MOUNT_MISSING_METRIC = 'ui.hud.mount_missing';

/** Counter raised once per `mount` the router applied. */
const HOST_MOUNTED_METRIC = 'ui.hud.host_mounted';

/** Counter raised per `mount` call after the first. */
const HOST_REMOUNTED_METRIC = 'ui.hud.host_remounted';

/**
 * Counter raised once per COMMITTED payload written, which is `render` and no
 * other member.
 *
 * It was raised by the shared writer, so the router's own `enter` and `update`
 * — which write the context they were handed rather than a commit — counted
 * here too, and one `state:commit` that arrived while the flow entered the
 * stage state raised it twice. A reader reconciling this against
 * `engine_events_total{event="state:commit"}` was reading lifecycle writes as
 * commits.
 */
const COMMIT_METRIC = 'ui.hud.commit';

/**
 * Counter raised once per LIFECYCLE payload written: a context the router
 * handed to `enter` or `update`, which re-renders what the last commit left
 * rather than reporting a new one.
 */
const REFRESH_METRIC = 'ui.hud.refresh';

/** Counter raised per terminal overlay shown, carrying the verdict. */
const VERDICT_METRIC = 'ui.hud.verdict';

/** Counter raised per call that reaches a destroyed HUD. */
const WRITE_AFTER_DESTROY_METRIC = 'ui.hud.write_after_destroy';

/** Counter raised once per `destroy`. */
const DESTROYED_METRIC = 'ui.hud.destroyed';

/** Counter raised once per stage indicator written. */
const STAGE_METRIC = 'ui.hud.stage';

/** Counter raised per stage indicator skipped, carrying the cause. */
const STAGE_SKIPPED_METRIC = 'ui.hud.stage.skipped';

/** Counter raised once per tray reconciliation, carrying the row counts. */
const RELIC_TRAY_METRIC = 'ui.hud.relic_tray';

/** Counter raised per persistence-status CHANGE written, carrying the status. */
const PERSISTENCE_METRIC = 'ui.hud.persistence';

/** Counter raised once per relic first shown as degraded, and per recovery. */
const DEGRADED_RELIC_METRIC = 'ui.hud.relic_degraded';

/** Counter raised per lifecycle call, carrying the member. */
const LIFECYCLE_METRIC = 'ui.hud.lifecycle';

/** Counter raised per context whose state is not the one this screen owns. */
const CONTEXT_REFUSED_METRIC = 'ui.hud.context_refused';

/** Counter raised per focus placement, carrying the source. */
const FOCUS_METRIC = 'ui.hud.focus';

/** Counter raised per score write skipped as unchanged. */
const SCORE_UNCHANGED_METRIC = 'ui.hud.score.unchanged';

/** Counter raised per announcement written, carrying the kind. */
const ANNOUNCED_METRIC = 'ui.hud.announced';

/** Counter raised per injected reader that raised or answered badly. */
const READER_FAULT_METRIC = 'ui.hud.reader.faulted';

/* ==========================================================================
 * 3. Public API
 * ========================================================================== */

/** Which terminal state the overlay is showing, and `null` for none. */
export type HudTerminalState = 'won' | 'over' | null;

/** What one payload put on screen, as plain data. */
export interface HudSnapshot {
  readonly score: number;

  /**
   * The best score exactly as the payload carried it: the raw stored string
   * when a value is present and the number `0` when it is absent, which is
   * what js/local_storage_manager.js L43-L45 returned and js/game_manager.js
   * L95 placed in the payload. Neither coerced nor formatted here.
   */
  readonly bestScore: BestScoreValue;

  /** The terminal state in force, and `null` while play continues. */
  readonly terminal: HudTerminalState;

  /** Verdict text written into the overlay, and `null` where none was. */
  readonly verdict: string | null;

  /**
   * One-based stage number shown, and `null` where no indicator resolved or no
   * stage was measurable. One-based here as player-facing copy; the engine's
   * own index stays zero-based everywhere else.
   */
  readonly stage: number | null;

  /** Relic identifiers shown in the tray, in the order supplied. */
  readonly relics: readonly string[];

  /**
   * The board dimension the payload reported, read live on every write and
   * never cached, and `null` where the payload carried none.
   */
  readonly boardSize: number | null;

  /**
   * Whether the payload reported its terminal or stage status as
   * unestablished. Recorded whether or not a run-status outlet resolved to
   * show it.
   */
  readonly degraded: boolean;
}

/**
 * The part of the announcer this screen drives, as ../a11y/live-region
 * declares it. A structural subset, so the announcer is exercisable with a
 * stand-in.
 */
export type HudAnnouncerPort = Pick<
  LiveRegionAnnouncer,
  'announce' | 'announceText'
>;

/**
 * The announcer as an option: the component itself, `null` for none, or a
 * reader resolved at the moment of the announcement, which a composition whose
 * announcer is built after this screen passes.
 */
export type HudAnnouncerSource =
  | HudAnnouncerPort
  | null
  | (() => HudAnnouncerPort | null);

/**
 * Reads the relics a run holds, in pickup order.
 *
 * `RelicRegistry.active` of src/relics/relic-registry.ts has this shape: it
 * returns the held relics in pickup order with the charge budgets the hook bus
 * holds. Called on every write, so a budget spent between turns is observed.
 */
export type HudRelicSource = () => readonly ActiveRelic[];

/** Reads the board dimension in force. */
export type HudBoardSizeSource = () => number | null;

/** Everything the factory accepts. Every member is optional. */
export interface HudOptions {
  /**
   * Score outlet, already resolved. Handed straight to `ScorePanel`, which is
   * the only component that writes it.
   */
  readonly scoreContainer?: HTMLElement | null;

  /** Best-score outlet, already resolved. */
  readonly bestContainer?: HTMLElement | null;

  /**
   * Terminal overlay. A selector is resolved against `document`; an element is
   * used as given.
   */
  readonly messageContainer?: Element | string | null;

  /**
   * The in-run status group, whose `hidden` this screen releases on the first
   * write. Defaults to `HUD_SELECTOR`, and `mount` adopts the container the
   * router injects where no group resolved here.
   */
  readonly hudContainer?: Element | string | null;

  /** The stage indicator. Defaults to `STAGE_SELECTOR`. */
  readonly stageContainer?: Element | string | null;

  /** The active-relic tray. Defaults to `RELIC_TRAY_SELECTOR`. */
  readonly relicTrayContainer?: Element | string | null;

  /**
   * The region focus is placed inside on entry. A selector is resolved against
   * `document`; an element is used as given.
   */
  readonly focusContainer?: Element | string | null;

  /**
   * Reads the held relics in pickup order, which is what the tray renders.
   * Absent, the tray is rendered from the payload's own relic slice and the
   * two resolvers below.
   */
  readonly relics?: HudRelicSource;

  /**
   * Reads the board dimension in force, consulted where a payload carries
   * none. Called on every write; nothing is cached from it.
   */
  readonly boardSize?: HudBoardSizeSource;

  /**
   * Reads the identifiers of the held relics the hook bus has marked DEGRADED.
   * `RelicRegistry.degradedIds()` satisfies it, and it is durable state: the
   * bus skips a marked relic for the rest of its registration.
   *
   * Absent, or raising, no row is marked — which is the state before this
   * reader existed, and which showed a relic that no longer fires as healthy.
   * Called on every write; nothing is cached from it.
   */
  readonly degradedRelics?: () => readonly string[];

  /**
   * Reads whether the run in force is reaching storage.
   * `RunController.persistenceStatus()` satisfies it. Called on every write.
   *
   * Absent, or raising, the run is treated as persistent, which is what a run
   * whose writes are all succeeding reports.
   */
  readonly persistence?: () => 'persistent' | 'ephemeral';

  /**
   * Resolves a relic identifier to the name the tray shows.
   *
   * A payload's relic slice carries an identifier and a charge count and
   * nothing else, and the catalogue that holds a display name lives in
   * src/relics, which this module does not import. Absent, or returning a
   * blank string, falls back to the identifier.
   */
  readonly relicName?: (relicId: string) => string;

  /**
   * Resolves a relic identifier to its tier. Absent, or returning a blank
   * string, leaves `data-rarity` unwritten and the row's text unchanged.
   */
  readonly relicRarity?: (relicId: string) => string;

  /** Region the charge-change announcement is written through. */
  readonly announcer?: HudAnnouncerSource;

  /**
   * Whether a changed charge budget is announced. Defaults to `true`, and is
   * inert where no announcer is supplied.
   */
  readonly announceCharges?: boolean;

  /**
   * Whether a relic appearing in the tray for the first time is announced as
   * an acquisition. Defaults to `false`: a composition whose reward
   * transaction announces the pickup itself leaves this off, and one with no
   * such transaction turns it on.
   */
  readonly announceAcquisitions?: boolean;

  /** Document a lookup runs against. Defaults to the ambient document. */
  readonly document?: Document;

  /** Copy overrides. Any member may be replaced. */
  readonly copy?: Partial<HudCopy>;

  /** Sink every miss, every write and every skipped write reports through. */
  readonly reporter?: UiReporter;
}

/**
 * The mounted HUD: the `Screen` of ../screen-router, plus the commit push and
 * the readers a host drives it with. Every member is safe to call at any time.
 */
export interface Hud extends Screen {
  /**
   * Receives the container the router resolved for this state, once. Any
   * outlet that did not resolve at construction is resolved inside that
   * container.
   *
   * @param host The resolved container.
   */
  mount(host: Element): void;

  /**
   * Renders one entry to this state and places focus.
   *
   * @param context The context the router built. A context for another state
   *   is reported and refused.
   */
  enter(context: ScreenContext): void;

  /**
   * Renders one in-state refresh. Focus is not moved and nothing is rebuilt
   * that did not change.
   *
   * @param context The context the router built.
   */
  update(context: ScreenContext): void;

  /** Marks this state left. Nothing rendered is torn down. */
  leave(): void;

  /** Tears the screen down. Equivalent to `destroy`. */
  unmount(): void;

  /**
   * Writes one commit: the score, then the best score, then the overlay, then
   * the run-status half, which is the order js/html_actuator.js L24-L27 wrote
   * the first three in.
   *
   * @param commit The commit to write.
   * @returns What was written.
   */
  render(commit: StateCommitEvent): HudSnapshot;

  /** What the last write put on screen, or `null` before the first. */
  readRendered(): HudSnapshot | null;

  /** Whether this state has been entered and not yet left. */
  isActive(): boolean;

  /** Whether the terminal overlay resolved. */
  hasOverlay(): boolean;

  /**
   * Clears the terminal overlay and records it cleared, without a commit.
   *
   * The commit path clears the overlay on the payload that reports no terminal
   * state, which is how restart and keep-playing clear it (TR-HUD-04). A run
   * that ENDED takes no further commit, so the flow reaching a screen carrying
   * its own verdict calls this instead. DL-HUD-13.
   *
   * @returns Whether a verdict was on screen to clear.
   */
  clearTerminalOverlay(): boolean;

  /** The score component this screen drives, for a caller that reads it. */
  readonly scorePanel: ScorePanel;

  /** Whether the stage indicator resolved. */
  hasStageIndicator(): boolean;

  /** Whether the relic tray resolved. */
  hasRelicTray(): boolean;

  /**
   * Removes every node this screen created, releases the score component and
   * the tray rows, and clears the overlay classes it added. Every later call
   * is a reported no-op.
   */
  destroy(): void;
}

/**
 * One payload reduced to what this screen writes, whichever member of the
 * public surface delivered it.
 */
interface HudView {
  readonly score: number;
  readonly bestScore: BestScoreValue;

  /** The terminal state the payload reported, and `null` for none. */
  readonly terminal: HudTerminalState;

  /** Zero-based stage index, and `null` where the payload carried none. */
  readonly stageIndex: number | null;

  /** The goal in force, and `null` where none was measurable. */
  readonly goal: StageGoal | null;

  /** Fraction of the goal reached, in the closed interval [0, 1]. */
  readonly goalFraction: number;

  /**
   * The measured quantity, where the payload stated it, and `null` where it is
   * to be derived from the fraction and the target.
   */
  readonly goalAchieved: number | null;

  /** The held relics, in the order supplied. */
  readonly relics: readonly ActiveRelic[];

  /** The live board dimension, and `null` where none was available. */
  readonly boardSize: number | null;

  readonly degraded: boolean;
}

/**
 * Reads the ambient document.
 *
 * @returns The document, or `null` outside a browser.
 */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Narrows an element to the HTML element whose `classList`, `hidden` and
 * `ownerDocument` this module reads.
 *
 * @param element Element to narrow, or `null`.
 * @returns The element, or `null` where it carries no `classList`.
 */
function asHtmlElement(element: Element | null): HTMLElement | null {
  if (element === null) {
    return null;
  }

  return 'classList' in element ? (element as HTMLElement) : null;
}

/**
 * Merges a caller's overrides onto the default copy.
 *
 * @param overrides Subset to replace, or `undefined` for none.
 * @returns The copy in force, frozen.
 */
function mergeCopy(overrides: Partial<HudCopy> | undefined): HudCopy {
  if (overrides === undefined) {
    return hudCopy;
  }

  return Object.freeze({ ...hudCopy, ...overrides });
}

/**
 * Maps a reported fraction into the closed interval [0, 1].
 *
 * @param fraction Reported fraction.
 * @returns The fraction, clamped, and `0` where it is not finite.
 */
function clampFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) {
    return 0;
  }

  return Math.min(Math.max(fraction, 0), 1);
}

/**
 * Reads a board's dimension without holding the board.
 *
 * @param board The board a payload carried, by reference and never written.
 * @returns The dimension, or `null` where the value is not a positive
 *   integer.
 */
function readBoardSizeOf(board: unknown): number | null {
  if (board === null || typeof board !== 'object') {
    return null;
  }

  const size = (board as { size?: unknown }).size;

  return typeof size === 'number' && Number.isInteger(size) && size > 0
    ? size
    : null;
}

/**
 * Reads the terminal state a commit reports.
 *
 * Ported from js/html_actuator.js L27-L33: the overlay is decided from the
 * terminal flags alone, and a loss takes precedence over a win, which a board
 * carrying both flags resolves to.
 *
 * @param commit Commit to read.
 * @returns The terminal state, and `null` while play continues.
 */
function readTerminal(commit: StateCommitEvent): HudTerminalState {
  if (!commit.terminated) {
    return null;
  }

  if (commit.over) {
    return 'over';
  }

  return commit.won ? 'won' : null;
}

/* ==========================================================================
 * 5. Construction
 * ========================================================================== */

/** One tray row on screen, and the relic it addresses. */
interface TrayEntry {
  /** The relic's identifier, which the row is reused by. */
  readonly id: string;

  /** The row itself, held so it is updated in place and destroyed once. */
  readonly item: RelicTrayItem;
}

/**
 * Mounts the in-run HUD.
 *
 * @param options Pre-resolved outlets, readers, document, copy and report
 *   sink.
 * @returns The mounted screen, whether or not every outlet resolved.
 * @example
 * ```ts
 * const hud = createHud({
 *   scoreContainer: document.querySelector('.score-container'),
 *   bestContainer: document.querySelector('.best-container'),
 *   relics: () => registry.active(),
 * });
 *
 * // Driven by the router, as the `stage` state's module:
 * const router = createScreenRouter({ screens: { stage: hud } });
 *
 * // Or driven by a commit the host pushes:
 * hud.render(commit);
 * ```
 */
export function createHud(options: HudOptions = {}): Hud {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const owner = options.document ?? readAmbientDocument();
  const copy = mergeCopy(options.copy);
  const announceCharges = options.announceCharges ?? true;
  const announceAcquisitions = options.announceAcquisitions ?? false;

  /**
   * The two strings a tray row renders, handed to `createRelicTrayItem` so an
   * override of this module's copy reaches the rows as well.
   */
  const trayCopy = Object.freeze({
    chargesRemaining: copy.relicCharges,
    rarityText: copy.relicRarity,
  });

  const scorePanel = createScorePanel({
    scoreContainer: options.scoreContainer ?? null,
    bestContainer: options.bestContainer ?? null,
    ...(owner === null ? {} : { document: owner }),
    reporter,
  });

  /**
   * Resolves one outlet: a supplied element is used as given, a selector is
   * resolved through the guarded lookup, and nothing falls back to this
   * module's own selector for the mount.
   *
   * @param supplied Element or selector the caller injected.
   * @param fallback Selector used where the caller injected neither.
   * @param mount Logical name carried into the report.
   * @param root Root the selector is evaluated against. Defaults to `owner`.
   * @returns The outlet, or `null`.
   */
  const resolveOutlet = (
    supplied: Element | string | null | undefined,
    fallback: string,
    mount: string,
    root: Element | Document | null = owner,
  ): HTMLElement | null => {
    const injected =
      supplied === null ||
      supplied === undefined ||
      typeof supplied === 'string'
        ? null
        : asHtmlElement(supplied);
    const selector =
      supplied === null || supplied === undefined
        ? fallback
        : typeof supplied === 'string'
          ? supplied
          : null;
    const resolved =
      selector === null
        ? injected
        : resolveMount<HTMLElement>(selector, {
            name: mount,
            ...(root === null ? {} : { root }),
            reporter,
            context: REPORT_CONTEXT,
          });

    if (resolved === null) {
      reporter.count(MOUNT_MISSING_METRIC, { mount, context: REPORT_CONTEXT });
    }

    return resolved;
  };

  const overlay = resolveOutlet(
    options.messageContainer,
    MESSAGE_SELECTOR,
    MESSAGE_MOUNT,
  );

  // The three run-status outlets. Mutable.
  let hudGroup = resolveOutlet(
    options.hudContainer,
    HUD_SELECTOR,
    HUD_MOUNT,
  );
  let stageOutlet = resolveOutlet(
    options.stageContainer,
    STAGE_SELECTOR,
    STAGE_MOUNT,
  );
  let relicTray = resolveOutlet(
    options.relicTrayContainer,
    RELIC_TRAY_SELECTOR,
    RELIC_TRAY_MOUNT,
  );

  /**
   * The container the router injected, held so `enter` can fall back to it.
   */
  let mountedHost: Element | null = null;

  let destroyed = false;
  let active = false;
  let rendered: HudSnapshot | null = null;

  /**
   * The stage slice last written, so an unchanged indicator rebuilds nothing.
   * A payload arrives on every turn and the indicator changes on a stage
   * transition, a progress step or a board mutation alone.
   */
  let lastStage: string | null = null;

  /** The one-based stage number last written, reported by a skipped write. */
  let lastStageNumber: number | null = null;

  /** The score pair last written, compared before a context refresh writes. */
  let lastScore: {
    readonly score: number;
    readonly best: BestScoreValue;
  } | null = null;

  /** The unconfirmed-status notice, built on first use and kept afterwards. */
  let degradedNotice: HTMLElement | null = null;

  /** The run-not-saved notice, built on first use and kept afterwards. */
  let ephemeralNotice: HTMLElement | null = null;

  /** The persistence status last written, so a change is announced once. */
  let lastPersistence: 'persistent' | 'ephemeral' | null = null;

  /** Relics already announced as degraded, so each is announced once. */
  const announcedDegraded = new Set<string>();

  /** The empty-state row, built on first use and kept afterwards. */
  let emptyRow: HTMLElement | null = null;

  /** The rows on screen, in the order they are rendered in. */
  let trayEntries: TrayEntry[] = [];

  /** The budget last announced per relic, keyed by identifier. */
  const lastCharges = new Map<string, number | undefined>();

  /** Whether a relic slice was written, so a restored loadout stays silent. */
  let seenRelics = false;

  /**
   * Records a call that reached a destroyed screen.
   *
   * @param member Name of the member called.
   */
  const reportAfterDestroy = (member: string): void => {
    reporter.log('debug', 'A call reached a destroyed HUD.', {
      member,
      context: REPORT_CONTEXT,
    });
    reporter.count(WRITE_AFTER_DESTROY_METRIC, {
      member,
      context: REPORT_CONTEXT,
    });
  };

  /**
   * Resolves the announcer for one announcement.
   *
   * @returns The announcer, or `null` where none is available.
   */
  const readAnnouncer = (): HudAnnouncerPort | null => {
    const source = options.announcer;

    if (source === null || source === undefined) {
      return null;
    }

    if (typeof source !== 'function') {
      return source;
    }

    try {
      return source() ?? null;
    } catch (error: unknown) {
      reporter.error('the HUD announcer reader raised', error, {
        context: REPORT_CONTEXT,
        reader: 'announcer',
      });
      reporter.count(READER_FAULT_METRIC, {
        context: REPORT_CONTEXT,
        reader: 'announcer',
      });

      return null;
    }
  };

  /**
   * Writes one line into the live region.
   *
   * The canvas is `aria-hidden`, so the DOM layer is the only channel a charge
   * count reaches a screen-reader user through.
   *
   * @param text Line to announce.
   * @param kind Kind carried into the report.
   * @param polarity CHANGED: polarity the line is written with. Omitted, the
   *   announcer's own default governs, which is polite — the behaviour every
   *   caller but the persistence notice keeps. DL-HUD-15.
   */
  const announceLine = (
    text: string,
    kind: string,
    polarity?: AnnouncementPolarity,
  ): void => {
    const announcer = readAnnouncer();

    if (announcer === null) {
      return;
    }

    try {
      announcer.announceText(text, polarity);
      reporter.count(ANNOUNCED_METRIC, {
        context: REPORT_CONTEXT,
        kind,
        polarity: polarity ?? 'default',
      });
    } catch (error: unknown) {
      reporter.error('a HUD announcement raised', error, {
        context: REPORT_CONTEXT,
        kind,
      });
    }
  };

  /**
   * Announces one relic taken through the structured `relicAcquired` variant
   * of ../a11y/live-region.
   *
   * PRIMITIVES, not the relic: that variant is typed over a name, a tier and a
   * budget, so the three fields are read off the declaration and passed as
   * strings and a number.
   *
   * @param relic The relic that joined the tray.
   */
  const announceAcquired = (relic: ActiveRelic): void => {
    const announcer = readAnnouncer();

    if (announcer === null) {
      return;
    }

    const definition = relic.definition;

    try {
      announcer.announce({
        kind: 'relicAcquired',
        name: definition.name,
        rarity: definition.rarity,
        charges: relic.charges,
      });
      reporter.count(ANNOUNCED_METRIC, {
        context: REPORT_CONTEXT,
        kind: 'relicAcquired',
      });
    } catch (error: unknown) {
      reporter.error('a HUD acquisition announcement raised', error, {
        context: REPORT_CONTEXT,
        relicId: definition.id,
      });
    }
  };

  /**
   * Announces what changed about the tray, and records the budgets the next
   * write compares against.
   *
   * A budget is read from the relic the write rendered, so what is announced
   * is what the row shows. The relics standing at the first write are the
   * run's restored loadout and are recorded without an acquisition
   * announcement.
   *
   * @param relics The relics just rendered, in the order supplied.
   */
  const reconcileAnnouncements = (
    relics: readonly ActiveRelic[],
  ): void => {
    const present = new Set<string>();

    for (const relic of relics) {
      const id = relic.definition.id;
      const charges = relic.charges;

      present.add(id);

      const known = lastCharges.has(id);
      const previous = lastCharges.get(id);

      lastCharges.set(id, charges);

      if (!known) {
        if (seenRelics && announceAcquisitions) {
          announceAcquired(relic);
        }

        continue;
      }

      if (announceCharges && charges !== undefined && charges !== previous) {
        announceLine(
          copy.chargeAnnouncement(relic.definition.name, charges),
          'charges',
        );
      }
    }

    for (const id of Array.from(lastCharges.keys())) {
      if (!present.has(id)) {
        lastCharges.delete(id);
      }
    }

    seenRelics = true;
  };

  /* ------------------------------------------------------------------------
   * The run-status group
   * ---------------------------------------------------------------------- */

  /** Releases the run-status group's `hidden`, once, on the first write. */
  const revealGroup = (): void => {
    if (hudGroup !== null && hudGroup.hidden) {
      hudGroup.hidden = false;
    }
  };

  /**
   * Shows or clears the unconfirmed-status notice.
   *
   * @param degraded What the payload reported.
   * @returns The flag, so a snapshot records what was asked for even where
   *   no outlet resolved to write it into.
   */
  const renderDegraded = (degraded: boolean): boolean => {
    if (hudGroup === null) {
      return degraded;
    }

    if (degraded) {
      hudGroup.setAttribute(DEGRADED_ATTRIBUTE, ARIA_TRUE);
    } else {
      hudGroup.removeAttribute(DEGRADED_ATTRIBUTE);
    }

    if (degradedNotice === null) {
      const doc = hudGroup.ownerDocument ?? owner;

      if (doc === null) {
        return degraded;
      }

      degradedNotice = doc.createElement('p');
      degradedNotice.className = DEGRADED_CLASS;
      degradedNotice.textContent = copy.degradedNotice;
      hudGroup.append(degradedNotice);
    }

    degradedNotice.hidden = !degraded;

    return degraded;
  };

  /* ------------------------------------------------------------------------
   * The stage indicator
   * ---------------------------------------------------------------------- */

  /**
   * Shows or clears the run-not-saved notice, and announces a CHANGE of it
   * once.
   *
   * The player-facing half of a persistence failure: the run continues to be
   * played from memory, and this is what says a reload will not resume it.
   * Announced on the transition alone, because a store that has run out of
   * quota refuses every write of the rest of the run.
   *
   * @param status The status the run's last write left.
   * @returns The status written.
   */
  const renderPersistence = (
    status: 'persistent' | 'ephemeral',
  ): 'persistent' | 'ephemeral' => {
    const changed = lastPersistence !== null && lastPersistence !== status;
    const first = lastPersistence === null;

    lastPersistence = status;

    if (hudGroup !== null) {
      const ephemeral = status === 'ephemeral';

      if (ephemeral) {
        hudGroup.setAttribute(EPHEMERAL_ATTRIBUTE, ARIA_TRUE);
      } else {
        hudGroup.removeAttribute(EPHEMERAL_ATTRIBUTE);
      }

      const doc = hudGroup.ownerDocument ?? owner;

      if (ephemeralNotice === null && doc !== null) {
        ephemeralNotice = doc.createElement('p');
        ephemeralNotice.className = EPHEMERAL_CLASS;
        ephemeralNotice.textContent = copy.ephemeralNotice;
        hudGroup.append(ephemeralNotice);
      }

      if (ephemeralNotice !== null) {
        ephemeralNotice.hidden = !ephemeral;
      }
    }

    // Announced on a change, and on a FIRST write that is already ephemeral —
    // a run resumed into a store that is refusing writes — and never on the
    // ordinary first write, which would say the run is being saved to a player
    // who has no reason to think otherwise.
    if (changed || (first && status === 'ephemeral')) {
      announceLine(
        status === 'ephemeral'
          ? copy.ephemeralAnnouncement
          : copy.persistentAnnouncement,
        'persistence',

        // CHANGED: the LOSS of persistence is written assertively, into the
        // `role="alert"` region ../a11y/live-region.ts keeps for that polarity
        // — the treatment src/main.ts already gives a lost WebGL context. The
        // recovery keeps the default polite polarity. The notice element itself
        // takes no `role="alert"`. DL-HUD-15.
        status === 'ephemeral' ? ASSERTIVE_POLARITY : undefined,
      );
      reporter.count(PERSISTENCE_METRIC, {
        context: REPORT_CONTEXT,
        status,
      });
    }

    return status;
  };

  /**
   * Builds one labelled readout: a label above a value, which is the pattern
   * style/_hud.scss dresses as `.hud-label` and `.hud-value`.
   *
   * @param doc Document the nodes are created in.
   * @param className Class of the group.
   * @param label Label text.
   * @param value Value text.
   * @returns The group.
   */
  const buildReadout = (
    doc: Document,
    className: string,
    label: string,
    value: string,
  ): HTMLElement => {
    const group = doc.createElement('div');

    group.className = className;

    const labelNode = doc.createElement('span');

    labelNode.className = LABEL_CLASS;
    labelNode.textContent = label;

    const valueNode = doc.createElement('span');

    valueNode.className = VALUE_CLASS;
    valueNode.textContent = value;

    group.append(labelNode, valueNode);

    return group;
  };

  /**
   * Builds the goal track, whose fill the reported fraction drives.
   *
   * DECORATIVE: the track carries `aria-hidden`, and the quantity it depicts
   * is announced by the `.hud-value` sibling beside it. See `DL-HUD-10`.
   *
   * @param doc Document the nodes are created in.
   * @param fraction Fraction of the goal reached, in [0, 1].
   * @returns The track.
   */
  const buildGoalMeter = (doc: Document, fraction: number): HTMLElement => {
    const meter = doc.createElement('div');

    meter.className = GOAL_METER_CLASS;
    meter.setAttribute(HIDDEN_ATTRIBUTE, ARIA_TRUE);

    const fill = doc.createElement('div');

    fill.className = GOAL_METER_FILL_CLASS;
    fill.style.setProperty(GOAL_FRACTION_PROPERTY, String(fraction));
    meter.append(fill);

    return meter;
  };

  /**
   * Writes the stage indicator: the stage number, the goal readout with its
   * track, and the live board dimension.
   *
   * The board dimension is read from the view on every call and nothing
   * derived from it is held, so a board-mutating relic is reflected on the
   * turn it takes effect and again after a reload.
   *
   * @param view The payload's normalised view.
   * @returns The one-based stage number written, or `null` where none was.
   */
  const renderStage = (view: HudView): number | null => {
    if (stageOutlet === null) {
      return null;
    }

    const doc = stageOutlet.ownerDocument ?? owner;

    if (doc === null) {
      reporter.count(STAGE_SKIPPED_METRIC, {
        context: REPORT_CONTEXT,
        cause: 'no-document',
      });

      return null;
    }

    const stageIndex = view.stageIndex;

    if (stageIndex === null) {
      reporter.count(STAGE_SKIPPED_METRIC, {
        context: REPORT_CONTEXT,
        cause: 'no-stage',
      });

      return lastStageNumber;
    }

    const goal = view.goal;
    const fraction = view.goalFraction;

    // The measured quantity as the payload stated it, and otherwise derived
    // from the target and the reported fraction, so the readout carries exactly
    // the progress the run reported and cannot disagree with it.
    const measured =
      goal === null
        ? 0
        : (view.goalAchieved ?? Math.round(fraction * goal.target));
    const boardSize = view.boardSize;
    const signature = [
      stageIndex,
      goal === null ? 'none' : goal.kind,
      goal === null ? 0 : goal.target,
      measured,
      fraction,
      boardSize ?? 0,
    ].join('|');
    const number = stageIndex + 1;

    if (signature === lastStage) {
      return number;
    }

    lastStage = signature;
    lastStageNumber = number;

    const groups: HTMLElement[] = [
      buildReadout(
        doc,
        STAGE_INDEX_CLASS,
        copy.stageLabel,
        copy.stageValue(stageIndex),
      ),
    ];

    if (goal !== null) {
      const goalGroup = buildReadout(
        doc,
        GOAL_CLASS,
        copy.goalLabel,
        copy.goalValue(goal.kind, goal.target, measured),
      );

      goalGroup.append(buildGoalMeter(doc, fraction));
      groups.push(goalGroup);
    }

    if (boardSize !== null) {
      groups.push(
        buildReadout(
          doc,
          BOARD_CLASS,
          copy.boardLabel,
          copy.boardValue(boardSize),
        ),
      );
    }

    stageOutlet.replaceChildren(...groups);

    reporter.count(STAGE_METRIC, {
      context: REPORT_CONTEXT,
      stageIndex,
      goalKind: goal === null ? 'none' : goal.kind,
      goalTarget: goal === null ? 0 : goal.target,
      boardSize: boardSize ?? 0,
    });

    return number;
  };

  /**
   * Reads one relic's display name through the injected resolver.
   *
   * @param relicId Identifier to resolve.
   * @returns The name, or the identifier.
   */
  const readName = (relicId: string): string => {
    const resolve = options.relicName;

    if (resolve === undefined) {
      return relicId;
    }

    try {
      const answer = resolve(relicId);

      return typeof answer === 'string' && answer.length > 0
        ? answer
        : relicId;
    } catch (error: unknown) {
      reporter.error('the HUD relic-name resolver raised', error, {
        context: REPORT_CONTEXT,
        relicId,
      });
      reporter.count(READER_FAULT_METRIC, {
        context: REPORT_CONTEXT,
        reader: 'relicName',
      });

      return relicId;
    }
  };

  /**
   * Reads one relic's tier through the injected resolver.
   *
   * @param relicId Identifier to resolve.
   * @returns The tier, or the empty string where none was resolved, which
   *   leaves `data-rarity` unwritten and the row's text unchanged.
   */
  const readRarity = (relicId: string): string => {
    const resolve = options.relicRarity;

    if (resolve === undefined) {
      return UNRESOLVED_RARITY;
    }

    try {
      const answer = resolve(relicId);

      return typeof answer === 'string' ? answer : UNRESOLVED_RARITY;
    } catch (error: unknown) {
      reporter.error('the HUD relic-rarity resolver raised', error, {
        context: REPORT_CONTEXT,
        relicId,
      });
      reporter.count(READER_FAULT_METRIC, {
        context: REPORT_CONTEXT,
        reader: 'relicRarity',
      });

      return UNRESOLVED_RARITY;
    }
  };

  /**
   * Builds a held record from a payload's relic entry.
   *
   * A payload's slice carries an identifier and a charge count, so the name and
   * the tier come from the two resolvers and the remaining declaration members
   * are the neutral ones a tray row does not render. `pickupOrder` is the
   * entry's position in the slice, which the provider supplies in pickup
   * order.
   *
   * @param entry Entry to build from.
   * @param index Position in the slice.
   * @returns The held record.
   */
  const synthesiseRelic = (
    entry: RelicCommitEntry,
    index: number,
  ): ActiveRelic => ({
    definition: {
      id: entry.id,
      name: readName(entry.id),

      // The resolver's answer verbatim: a tier outside the ladder and the
      // empty string are both carried as they arrive, and
      // ../components/relic-card reports the former and writes no attribute
      // for the latter.
      rarity: readRarity(entry.id) as Rarity,
      description: '',
      hooks: NO_HOOKS,
    },
    pickupOrder: index,
    charges: entry.charges,
    state: undefined,
  });

  /**
   * Reads the degraded relic identifiers through the injected reader.
   *
   * @returns The identifiers the bus has marked, empty where no reader is
   *   supplied, it answered with anything but an array, or it raised.
   */
  const readDegradedRelics = (): ReadonlySet<string> => {
    const read = options.degradedRelics;

    if (read === undefined) {
      return EMPTY_ID_SET;
    }

    try {
      const answer = read();

      if (!Array.isArray(answer)) {
        reporter.count(READER_FAULT_METRIC, {
          context: REPORT_CONTEXT,
          reader: 'degradedRelics',
          cause: 'not-an-array',
        });

        return EMPTY_ID_SET;
      }

      return new Set(
        answer.filter((id): id is string => typeof id === 'string'),
      );
    } catch (error: unknown) {
      reporter.error('the HUD degraded-relic reader raised', error, {
        context: REPORT_CONTEXT,
        reader: 'degradedRelics',
      });
      reporter.count(READER_FAULT_METRIC, {
        context: REPORT_CONTEXT,
        reader: 'degradedRelics',
      });

      return EMPTY_ID_SET;
    }
  };

  /**
   * Reads the run's persistence status through the injected reader.
   *
   * @returns The status, and `'persistent'` where no reader is supplied, it
   *   answered with anything else, or it raised.
   */
  const readPersistence = (): 'persistent' | 'ephemeral' => {
    const read = options.persistence;

    if (read === undefined) {
      return 'persistent';
    }

    try {
      const answer = read();

      return answer === 'ephemeral' ? 'ephemeral' : 'persistent';
    } catch (error: unknown) {
      reporter.error('the HUD persistence reader raised', error, {
        context: REPORT_CONTEXT,
        reader: 'persistence',
      });
      reporter.count(READER_FAULT_METRIC, {
        context: REPORT_CONTEXT,
        reader: 'persistence',
      });

      return 'persistent';
    }
  };

  /**
   * Reads the held relics through the injected reader.
   *
   * @returns The relics, or `null` where no reader is supplied or it
   *   answered with anything but an array.
   */
  const readLiveRelics = (): readonly ActiveRelic[] | null => {
    const read = options.relics;

    if (read === undefined) {
      return null;
    }

    try {
      const answer = read();

      if (!Array.isArray(answer)) {
        reporter.count(READER_FAULT_METRIC, {
          context: REPORT_CONTEXT,
          reader: 'relics',
          cause: 'not-an-array',
        });

        return null;
      }

      return answer;
    } catch (error: unknown) {
      reporter.error('the HUD relic reader raised', error, {
        context: REPORT_CONTEXT,
        reader: 'relics',
      });
      reporter.count(READER_FAULT_METRIC, {
        context: REPORT_CONTEXT,
        reader: 'relics',
      });

      return null;
    }
  };

  /**
   * The relics one write renders, in the order supplied.
   *
   * THE READER IS THE AUTHORITY WHENEVER IT ANSWERS, and an empty answer is an
   * answer: a run holding no relic renders an empty tray. The payload's slice
   * is the fallback for a HUD composed WITHOUT a reader, and for a reader that
   * answered with a non-array or raised — both of which `readLiveRelics`
   * reports as `null`. An empty answer fell through to the slice, so a registry
   * emptied by a new run kept the previous run's rows on screen for as long as
   * the slice carried them. Decision DL-HUD-14.
   *
   * @param slice The payload's relic slice, already in pickup order.
   * @returns The relics to render.
   */
  const readActiveRelics = (
    slice: RelicCommitContext,
  ): readonly ActiveRelic[] => {
    const live = readLiveRelics();

    if (live !== null) {
      return live;
    }

    return slice.map(synthesiseRelic);
  };

  /** Destroys every row on screen and forgets them. */
  const clearTrayRows = (): void => {
    for (const entry of trayEntries) {
      entry.item.destroy();
    }

    trayEntries = [];
  };

  /**
   * Shows the empty-state row, building it once.
   *
   * A REAL list item carrying no role of its own, so the implicit `listitem` of
   * an `<li>` inside a `<ul>` stands and the `role="list"` on the tray keeps a
   * permitted child. Marked `data-relic-empty`, which style/_hud.scss reads to
   * suppress the slot counter on it.
   */
  const showEmptyRow = (): void => {
    if (relicTray === null) {
      return;
    }

    const doc = relicTray.ownerDocument ?? owner;

    if (doc === null) {
      return;
    }

    if (emptyRow === null) {
      emptyRow = doc.createElement('li');
      emptyRow.className = relicCardClasses.trayItem;
      emptyRow.setAttribute(EMPTY_TRAY_ATTRIBUTE, ARIA_TRUE);
      emptyRow.textContent = copy.relicTrayEmpty;
    }

    // Appended only where it is not already there: a payload arrives on every
    // turn and an append of an attached node is a move, which would relocate
    // the row once a turn for the whole time a run holds no relic.
    if (emptyRow.parentNode !== relicTray) {
      relicTray.append(emptyRow);
    }
  };

  /** Takes the empty-state row off screen, keeping it for reuse. */
  const hideEmptyRow = (): void => {
    emptyRow?.remove();
  };

  /**
   * Puts the rows in the order the relics were supplied in, moving only a row
   * that is not already where it belongs.
   *
   * @param entries Rows in the order they are to appear.
   */
  const orderTrayRows = (entries: readonly TrayEntry[]): void => {
    if (relicTray === null) {
      return;
    }

    let cursor: ChildNode | null = relicTray.firstChild;

    for (const entry of entries) {
      const element = entry.item.element;

      if (element === null) {
        continue;
      }

      if (cursor === element) {
        cursor = element.nextSibling;

        continue;
      }

      relicTray.insertBefore(element, cursor);
    }
  };

  /**
   * Writes the active-relic tray in pickup order, reusing the rows on screen.
   *
   * @param relics The relics to show, in the order supplied.
   * @returns The identifiers written, in that order.
   */
  const renderRelics = (
    relics: readonly ActiveRelic[],
    degraded: ReadonlySet<string>,
  ): readonly string[] => {
    const ids = Object.freeze(
      relics.map((relic): string => relic.definition.id),
    );

    // ANNOUNCED AND COUNTED WHATEVER THE TRAY CAN SHOW, and before the rows are
    // reconciled: a relic the bus has stopped firing is a change to the run,
    // and a page whose tray outlet never resolved must still say so. Each
    // identifier is announced once, and a relic that is no longer marked —
    // dropped and taken again — is forgotten so a later degradation is
    // announced afresh.
    for (const relic of relics) {
      const id = relic.definition.id;

      if (degraded.has(id)) {
        if (!announcedDegraded.has(id)) {
          announcedDegraded.add(id);
          announceLine(
            copy.degradedRelicAnnouncement(relic.definition.name),
            'relicDegraded',
          );
          reporter.count(DEGRADED_RELIC_METRIC, {
            context: REPORT_CONTEXT,
            relic: id,
          });
        }
      } else {
        announcedDegraded.delete(id);
      }
    }

    if (relicTray === null) {
      return ids;
    }

    relicTray.setAttribute('aria-label', copy.relicTrayLabel);

    if (relics.length === 0) {
      clearTrayRows();
      showEmptyRow();
      reporter.count(RELIC_TRAY_METRIC, {
        context: REPORT_CONTEXT,
        relics: 0,
        created: 0,
        removed: 0,
      });

      return ids;
    }

    hideEmptyRow();

    // Rows keyed by identifier, so a relic held twice keeps two rows and the
    // order below decides which of them is reused first.
    const reusable = new Map<string, TrayEntry[]>();

    for (const entry of trayEntries) {
      const pool = reusable.get(entry.id);

      if (pool === undefined) {
        reusable.set(entry.id, [entry]);
      } else {
        pool.push(entry);
      }
    }

    const next: TrayEntry[] = [];
    let created = 0;

    for (const relic of relics) {
      const id = relic.definition.id;
      const existing = reusable.get(id)?.shift();

      if (existing !== undefined) {
        existing.item.update(relic, degraded.has(id));
        next.push(existing);

        continue;
      }

      created += 1;
      next.push({
        id,
        item: createRelicTrayItem({
          relic,
          degraded: degraded.has(id),
          host: relicTray,
          ...(owner === null ? {} : { document: owner }),
          reporter,
          copy: trayCopy,
        }),
      });
    }

    let removed = 0;

    for (const pool of reusable.values()) {
      for (const entry of pool) {
        removed += 1;
        entry.item.destroy();
      }
    }

    trayEntries = next;
    orderTrayRows(next);

    reporter.count(RELIC_TRAY_METRIC, {
      context: REPORT_CONTEXT,
      relics: relics.length,
      created,
      removed,
      degraded: ids.filter((id): boolean => degraded.has(id)).length,
    });

    return ids;
  };

  /* ------------------------------------------------------------------------
   * The score outlets and the terminal overlay
   * ---------------------------------------------------------------------- */

  /**
   * Writes the score pair through `ScorePanel`, which is the only component
   * that touches either outlet.
   *
   * The best score is handed over EXACTLY as it arrived: never coerced,
   * never compared, never cached and never formatted.
   * js/local_storage_manager.js L43-L45 returns the raw stored string when a
   * value is present and the number `0` when it is absent, and
   * js/game_manager.js L80-L82 relies on the relational coercion of that
   * string.
   * The value rendered is the one js/game_manager.js L95 re-read from storage
   * after the possible write, so what is shown equals what is persisted.
   *
   * @param score Score the payload carried.
   * @param best Best score the payload carried.
   * @param rewrite Whether an unchanged pair is written again. A commit push
   *   rewrites, so a repeated commit clears the previous delta node exactly as
   *   js/html_actuator.js L107 did; a context refresh does not, so a second
   *   driver reporting the same turn cannot erase the delta the first showed.
   */
  const writeScore = (
    score: number,
    best: BestScoreValue,
    rewrite: boolean,
  ): void => {
    if (
      !rewrite &&
      lastScore !== null &&
      lastScore.score === score &&
      lastScore.best === best
    ) {
      reporter.count(SCORE_UNCHANGED_METRIC, { context: REPORT_CONTEXT });

      return;
    }

    lastScore = { score, best };

    // The score first, then the best score: the order of js/html_actuator.js
    // L24-L25, and the order the delta depends on, since the delta is computed
    // against the score the component last wrote.
    scorePanel.update({ score, bestScore: best });
  };

  /**
   * Shows the terminal overlay.
   *
   * Ported from js/html_actuator.js L127-L132: the state class first, then the
   * verdict into the overlay's own paragraph. An overlay carrying no paragraph
   * is reported and still receives its class, which is what the stylesheet
   * fades in.
   *
   * @param won Whether the verdict is the winning one.
   * @returns The verdict written, or the verdict that would have been.
   */
  const showMessage = (won: boolean): string => {
    const verdict = won ? copy.wonMessage : copy.overMessage;

    if (overlay === null) {
      return verdict;
    }

    overlay.classList.add(won ? WON_CLASS : OVER_CLASS);

    const paragraph = overlay.querySelector(SCOPED_VERDICT_SELECTOR);

    if (paragraph === null) {
      reporter.log('warn', 'The terminal overlay carries no verdict element.', {
        context: REPORT_CONTEXT,
        selector: VERDICT_SELECTOR,
      });

      return verdict;
    }

    paragraph.textContent = verdict;
    reporter.count(VERDICT_METRIC, { context: REPORT_CONTEXT, won });

    return verdict;
  };

  /**
   * Clears the terminal overlay.
   *
   * Ported from js/html_actuator.js L135-L139, which the manager reached
   * through `continueGame` L38-L41 on restart and on keep-playing. Both arrive
   * here as a payload reporting no terminal state.
   */
  const clearMessage = (): void => {
    if (overlay === null) {
      return;
    }

    overlay.classList.remove(WON_CLASS);
    overlay.classList.remove(OVER_CLASS);
  };

  /* ------------------------------------------------------------------------
   * The single write path
   * ---------------------------------------------------------------------- */

  /**
   * Writes one normalised view and records what it put on screen.
   *
   * @param view The view to write.
   * @param rewriteScore Whether an unchanged score pair is written again.
   * @param source Which counter the write is recorded on: `'commit'` for the
   *   payload `render` was handed, and `'lifecycle'` for a context the router
   *   handed `enter` or `update`. The two are counted apart because one
   *   `state:commit` produces exactly one commit write and any number of
   *   lifecycle writes.
   * @returns What was written.
   */
  const write = (
    view: HudView,
    rewriteScore: boolean,
    source: 'commit' | 'lifecycle',
  ): HudSnapshot => {
    if (destroyed) {
      reportAfterDestroy('write');

      return (
        rendered ?? {
          score: view.score,
          bestScore: view.bestScore,
          terminal: null,
          verdict: null,
          stage: null,
          relics: EMPTY_RELIC_IDS,
          boardSize: null,
          degraded: view.degraded,
        }
      );
    }

    revealGroup();
    writeScore(view.score, view.bestScore, rewriteScore);

    let verdict: string | null = null;

    if (view.terminal === 'over') {
      verdict = showMessage(false);
    } else if (view.terminal === 'won') {
      verdict = showMessage(true);
    } else {
      clearMessage();
    }

    // The run-status half, written after the two outlets js/html_actuator.js
    // owned, so their original write order stands and this addition cannot
    // delay them.
    const stage = renderStage(view);
    const relics = renderRelics(view.relics, readDegradedRelics());
    const degraded = renderDegraded(view.degraded);

    // The run-status half's second notice, written after the board's own so the
    // two read top to bottom in the order they were added.
    renderPersistence(readPersistence());

    reconcileAnnouncements(view.relics);

    rendered = Object.freeze({
      score: view.score,
      bestScore: view.bestScore,
      terminal: view.terminal,
      verdict,
      stage,
      relics,
      boardSize: view.boardSize,
      degraded,
    });

    reporter.count(source === 'commit' ? COMMIT_METRIC : REFRESH_METRIC, {
      context: REPORT_CONTEXT,
      score: view.score,
      terminal: view.terminal ?? 'none',
      relics: relics.length,
    });

    return rendered;
  };

  /**
   * Reads the board dimension one payload reports: the payload's own value
   * first, then the injected reader.
   *
   * Nothing is cached. A board-mutating relic changes the dimension mid-run,
   * so a value captured at mount goes stale; every consumer of it below
   * derives from this call.
   *
   * @param supplied The dimension the payload carried, or `null`.
   * @returns The dimension, or `null` where neither source answered.
   */
  const readBoardSize = (supplied: number | null): number | null => {
    if (supplied !== null) {
      return supplied;
    }

    const read = options.boardSize;

    if (read === undefined) {
      return null;
    }

    try {
      const answer = read();

      return typeof answer === 'number' &&
        Number.isInteger(answer) &&
        answer > 0
        ? answer
        : null;
    } catch (error: unknown) {
      reporter.error('the HUD board-size reader raised', error, {
        context: REPORT_CONTEXT,
        reader: 'boardSize',
      });
      reporter.count(READER_FAULT_METRIC, {
        context: REPORT_CONTEXT,
        reader: 'boardSize',
      });

      return null;
    }
  };

  /**
   * Reduces one commit to the view a write renders.
   *
   * The board travels BY REFERENCE on every payload and is read, never cloned
   * and never written: only its dimension is taken, and only for this call.
   *
   * @param commit Commit to reduce.
   * @returns The view.
   */
  const viewFromCommit = (commit: StateCommitEvent): HudView => ({
    score: commit.score,
    bestScore: commit.bestScore,
    terminal: readTerminal(commit),
    stageIndex: commit.stage.stageIndex,
    goal: commit.stage.goal,
    goalFraction: clampFraction(commit.stage.goalProgress),
    goalAchieved: null,
    relics: readActiveRelics(commit.relics),
    boardSize: readBoardSize(readBoardSizeOf(commit.board)),
    degraded: commit.degraded,
  });

  /**
   * Reduces one router context to the view a write renders, and refuses a
   * context for another state.
   *
   * `StageGoalProgress.progress` is used VERBATIM: `evaluateStageGoal` of
   * ../../config/stage-config already clamped it to the closed interval [0,
   * 1], and `achieved` is the measured quantity it stated, so neither is
   * rescaled here.
   *
   * @param context Context the router built.
   * @param member Lifecycle member carried into the report.
   * @returns The view, or `null` where the context is for another state.
   */
  const viewFromContext = (
    context: ScreenContext,
    member: string,
  ): HudView | null => {
    if (context.screen !== STAGE_SCREEN) {
      reporter.log('warn', 'The HUD received a context for another screen.', {
        context: REPORT_CONTEXT,
        member,
        screen: context.screen,
      });
      reporter.count(CONTEXT_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        member,
        screen: context.screen,
      });

      return null;
    }

    const progress = context.goalProgress;

    return {
      score: context.score,
      bestScore: context.bestScore,
      terminal: null,
      stageIndex: context.stageIndex,
      goal: context.goal,
      goalFraction: progress === null ? 0 : progress.progress,
      goalAchieved: progress === null ? null : progress.achieved,
      relics: readActiveRelics(context.relics),
      boardSize: readBoardSize(context.boardSize),
      degraded: context.degraded,
    };
  };

  /**
   * Resolves the container focus is placed inside on entry.
   *
   * @param host Container the entry carried, or `null`.
   * @returns The container, or `null`.
   */
  const resolveFocusContainer = (host: Element | null): Element | null => {
    const supplied = options.focusContainer;

    if (supplied === null) {
      return null;
    }

    if (supplied !== undefined && typeof supplied !== 'string') {
      return supplied;
    }

    const resolved = resolveMount<HTMLElement>(
      supplied ?? FOCUS_CONTAINER_SELECTOR,
      {
        name: FOCUS_MOUNT,
        ...(owner === null ? {} : { root: owner }),
        reporter,
        context: REPORT_CONTEXT,
      },
    );

    return resolved ?? host ?? mountedHost;
  };

  /**
   * Places focus for one entry to this state, through `focusInitial` of
   * ../a11y/focus-manager.
   *
   * @param host Container the entry carried, or `null`.
   */
  const placeFocus = (host: Element | null): void => {
    const container = resolveFocusContainer(host);

    if (container === null) {
      reporter.count(FOCUS_METRIC, {
        context: REPORT_CONTEXT,
        source: 'none',
        focused: false,
      });

      return;
    }

    const placement = focusInitial(STAGE_SCREEN, container, {
      reporter,
      context: REPORT_CONTEXT,
    });

    reporter.count(FOCUS_METRIC, {
      context: REPORT_CONTEXT,
      source: placement.source,
      focused: placement.focused,
    });
  };

  /* ------------------------------------------------------------------------
   * Teardown
   * ---------------------------------------------------------------------- */

  /** Removes every node this screen created and releases its collaborators. */
  const destroy = (): void => {
    if (destroyed) {
      reportAfterDestroy('destroy');

      return;
    }

    destroyed = true;
    active = false;

    clearMessage();

    // The notice and the empty-state row are this module's own elements, so
    // they leave with it, and the group is left carrying no state attribute of
    // ours.
    degradedNotice?.remove();
    degradedNotice = null;
    ephemeralNotice?.remove();
    ephemeralNotice = null;
    hideEmptyRow();
    emptyRow = null;
    hudGroup?.removeAttribute(DEGRADED_ATTRIBUTE);
    hudGroup?.removeAttribute(EPHEMERAL_ATTRIBUTE);

    clearTrayRows();
    lastCharges.clear();
    announcedDegraded.clear();
    lastPersistence = null;
    scorePanel.destroy();

    reporter.count(DESTROYED_METRIC, { context: REPORT_CONTEXT });
  };

  reporter.count(MOUNTED_METRIC, {
    context: REPORT_CONTEXT,
    score: scorePanel.isReady(),
    overlay: overlay !== null,
    stage: stageOutlet !== null,
    relicTray: relicTray !== null,
    zIndex: HUD_Z_INDEX,
  });

  return Object.freeze({
    scorePanel,

    mount(host: Element): void {
      if (destroyed) {
        reportAfterDestroy('mount');

        return;
      }

      if (mountedHost !== null) {
        reporter.count(HOST_REMOUNTED_METRIC, { context: REPORT_CONTEXT });

        return;
      }

      mountedHost = host;

      // The router is the authority that resolves and injects the container, so
      // the outlets that did not resolve at construction are resolved INSIDE it
      // rather than through a second document-wide lookup.
      hudGroup = hudGroup ?? asHtmlElement(host);
      stageOutlet =
        stageOutlet ??
        resolveOutlet(undefined, STAGE_SELECTOR, STAGE_MOUNT, host);
      relicTray =
        relicTray ??
        resolveOutlet(undefined, RELIC_TRAY_SELECTOR, RELIC_TRAY_MOUNT, host);

      reporter.count(HOST_MOUNTED_METRIC, {
        context: REPORT_CONTEXT,
        stage: stageOutlet !== null,
        relicTray: relicTray !== null,
      });
    },

    enter(context: ScreenContext): void {
      if (destroyed) {
        reportAfterDestroy('enter');

        return;
      }

      const view = viewFromContext(context, 'enter');

      // A REFUSED CONTEXT ENTERS NOTHING. `viewFromContext` answers `null` for
      // a context belonging to another screen and reports the refusal; this
      // member went on to mark the HUD active and place focus inside a host it
      // had just declined to render, which left the stage screen holding focus
      // and answering `isActive()` for a state it is not in. The refusal is
      // counted by `viewFromContext` itself, so nothing is reported twice here.
      if (view === null) {
        return;
      }

      active = true;

      write(view, false, 'lifecycle');

      // An in-state refresh never moves focus, whichever member delivered it.
      if (!context.refresh) {
        placeFocus(context.host);
      }

      reporter.count(LIFECYCLE_METRIC, {
        context: REPORT_CONTEXT,
        member: 'enter',
        trigger: context.trigger,
      });
    },

    update(context: ScreenContext): void {
      if (destroyed) {
        reportAfterDestroy('update');

        return;
      }

      const view = viewFromContext(context, 'update');

      if (view !== null) {
        write(view, false, 'lifecycle');
      }

      reporter.count(LIFECYCLE_METRIC, {
        context: REPORT_CONTEXT,
        member: 'update',
        trigger: context.trigger,
      });
    },

    leave(): void {
      if (destroyed) {
        reportAfterDestroy('leave');

        return;
      }

      active = false;

      reporter.count(LIFECYCLE_METRIC, {
        context: REPORT_CONTEXT,
        member: 'leave',
      });
    },

    unmount(): void {
      reporter.count(LIFECYCLE_METRIC, {
        context: REPORT_CONTEXT,
        member: 'unmount',
      });
      destroy();
    },

    // The words the router reads on entry, taken from the stage number this
    // screen has on screen. Decision DL-HUD-11.
    announcement: (): string =>
      copy.stageAnnouncement(rendered?.stage ?? lastStageNumber),

    render(commit: StateCommitEvent): HudSnapshot {
      return write(viewFromCommit(commit), true, 'commit');
    },

    readRendered: (): HudSnapshot | null => rendered,

    isActive: (): boolean => active,

    hasOverlay: (): boolean => overlay !== null,

    clearTerminalOverlay(): boolean {
      if (destroyed) {
        reportAfterDestroy('clearTerminalOverlay');

        return false;
      }

      const cleared = rendered !== null && rendered.terminal !== null;

      clearMessage();

      if (rendered !== null) {
        rendered = Object.freeze({ ...rendered, terminal: null,
          verdict: null });
      }

      return cleared;
    },

    hasStageIndicator: (): boolean => stageOutlet !== null,

    hasRelicTray: (): boolean => relicTray !== null,

    destroy,
  });
}
