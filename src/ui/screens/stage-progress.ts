// The stage-clear interstitial: the `stageClear` state of the screen flow,
// entered when a stage is resolved and left when the player continues into the
// reward screen.
//
// NO VANILLA ANALOGUE. The retired sources carried exactly one screen, no
// router, no hash handling and no History API use, and no construct in
// js/game_manager.js, js/grid.js or js/tile.js resolved a stage. Every row this
// module owns in docs/TRACEABILITY_MATRIX.md is therefore a target-only row,
// declared as having no source construct so the reverse direction of that
// matrix carries no gap.
//
// WHAT IT RENDERS, AND WHERE EACH VALUE COMES FROM
//   the stage that ended, whether it cleared, and the score at stage end —
//     the three members of the `stage:end` payload, typed here as
//     `StageEndEvent` of ../../engine/engine-events and delivered by the router
//     on the `StageClearScreenContext` of ../screen-router;
//   the goal in force — the `StageGoal` of ../../config/stage-config, carried
//     on the same context, rendered by branching on its `kind` discriminant;
//   the measured quantity and the goal fraction — the `achieved` and the
//     `progress` members of that module's `StageGoalProgress`. The `stageClear`
//     context carries neither, so both arrive through the injected ports of
//     `StageProgressOptions`, whose shapes are the accessor triple of
//     `RunController` in ../../run/run-controller.
//
// WHAT IT DOES NOT DO
//   it never subscribes to an engine event: every payload arrives from the
//     router, which is the sole subscriber that drives screens;
//   it never evaluates or re-evaluates a stage goal for the verdict. The
//     `cleared` flag rendered is the payload's own. `evaluateStageGoal` is
//     called for one purpose only — formatting a measured quantity the
//     payload does not carry — and its `progress` is used verbatim: never
//     re-clamped, never re-scaled against the target;
//   it never advances the run: `RunController.advanceStage()` owns the
//     lifecycle and the router owns the transition. The continue control
//     publishes the `continueStage` action and nothing more;
//   it never writes the container's `hidden` attribute, its `role`, its
//     `aria-modal` or its `aria-label`: index.html declares all four and the
//     router owns the attribute.
//
// LAYERING AND MOTION, BOTH READ FROM ../../theme/tokens
//   `STAGE_PROGRESS_LAYER` is `zIndex.screenOverlay`, the 300 rung of the
//     ladder extension, and is at or below `zIndex.modal` so the z-index-500
//     diagnostics overlay is never shadowed. No rule is emitted from here: the
//     container's stacking slot is declared by style/_screens.scss.
//   `STAGE_PROGRESS_CADENCE` is `motion.fadeIn`, the frozen overlay cadence of
//     an 800 ms fade after a 1200 ms delay. This module starts no animation and
//     schedules no timer, so there is nothing here to retime; the cadence is
//     published so a gate can read the interval it has to clear.
//   The one entrance behaviour that is sequenced is the scroll that follows
//     focus placement, and it is gated on the effective reduced-motion value:
//     the injected preference port first, then the value the router read at
//     the moment of the transition. style/_a11y.scss collapses the container's
//     fade for the same preference.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece:
//   TR-STAGECLEAR-01  target-only row  `createStageProgressScreen()` and the
//                                      five-member `Screen` lifecycle over the
//                                      `#screen-stage-progress` container
//   TR-STAGECLEAR-02  target-only row  the three `stage:end` facts rendered:
//                                      the stage index, the cleared flag and
//                                      the score
//   TR-STAGECLEAR-03  target-only row  the `StageGoal` kind branch and the
//                                      `StageGoalProgress` readout
//   TR-STAGECLEAR-04  target-only row  the hosted continue control, its
//                                      delegated activation and its
//                                      `data-focus-initial` marker
//
// Decisions: DL-STAGECLEAR-01, DL-STAGECLEAR-02, DL-STAGECLEAR-03,
// DL-STAGECLEAR-04 (docs/DECISION_LOG.md).

import { evaluateStageGoal } from '../../config/stage-config';
import type { StageGoal, StageGoalProgress } from '../../config/stage-config';
import type { StageEndEvent } from '../../engine/engine-events';
import type { RunController } from '../../run/run-controller';
import { motion, zIndex } from '../../theme/tokens';
import { FOCUS_INITIAL_ATTRIBUTE, focusInitial } from '../a11y/focus-manager';
import type { Announcement } from '../a11y/live-region';
import type { PreferenceStore, UiReporter } from '../a11y/settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from '../a11y/settings';
import { SCREEN_MOUNTS } from '../screen-router';
import type {
  Screen,
  ScreenContext,
  StageClearScreenContext,
} from '../screen-router';

/** The state this module renders, as ../screen-router names it. */
const SCREEN_NAME = 'stageClear' as const;

const HOST_SELECTOR: string = SCREEN_MOUNTS[SCREEN_NAME];

/** Logical name of the container, carried into every report. */
const HOST_MOUNT = 'stageProgress';

/** Short label naming this module in every report. */
const REPORT_CONTEXT = 'stage-progress';

/**
 * Class of the continue control, exported so src/input/on-screen-controls.ts
 * can promote and bind it through its `markupControls` list. It is a binding
 * hook and needs no rule: style/_screens.scss dresses every `button` inside
 * this container through `@mixin screen-content`, and `.screen-button` below
 * reaches the same vocabulary.
 */
export const CONTINUE_CONTROL_CLASS = 'stage-progress-continue';

/** `CONTINUE_CONTROL_CLASS` as a class selector. */
export const CONTINUE_CONTROL_SELECTOR = `.${CONTINUE_CONTROL_CLASS}`;

/** The classes of style/_screens.scss this module renders with. */
const SCREEN_CLASSES = Object.freeze({
  /**
   * ADDED: the bounded reading surface, the class `@mixin screen-panel-surface`
   * of style/_screens.scss dresses. It carries the opaque background and the
   * dark text colour, which is what every sibling screen appends its content
   * inside — ../screens/run-start.ts and ../screens/game-over.ts both render
   * one. DL-STAGECLEAR-06.
   */
  panel: 'screen-panel',

  /** The verdict type treatment, at both scales. */
  verdict: 'screen-verdict',

  /** Paragraph treatment: no margin, wrapping text. */
  text: 'screen-text',

  /** Bold inline label ahead of a value. */
  label: 'screen-label',

  /** The wrapping, centred control row. */
  actions: 'screen-actions',

  /** The button vocabulary, with its focus ring and interaction states. */
  button: 'screen-button',
});

/**
 * The stacking slot this screen occupies: the 300 rung of the ladder
 * extension. Published, never emitted — style/_screens.scss declares the
 * container's `z-index` and no inline style is written from here.
 */
export const STAGE_PROGRESS_LAYER: number = zIndex.screenOverlay;

/**
 * The frozen overlay cadence, from `motion.fadeIn`: an 800 ms fade after a
 * 1200 ms delay. `total` is the interval an assertion on the interstitial has
 * to clear.
 */
export const STAGE_PROGRESS_CADENCE = Object.freeze({
  delay: motion.fadeIn.delay,
  duration: motion.fadeIn.duration,
  total: motion.fadeIn.delay + motion.fadeIn.duration,
} as const);

/** Lower bound of a valid goal fraction. */
const FRACTION_FLOOR = 0;

/** Upper bound of a valid goal fraction. */
const FRACTION_CEILING = 1;

/** Multiplier that states a fraction as a percentage. */
const PERCENT_SCALE = 100;

/** Offset from a zero-based stage index to the number a player reads. */
const STAGE_NUMBER_OFFSET = 1;

/** The index a run's first stage carries, as the run-state envelope does. */
const FIRST_STAGE_INDEX = 0;

/** The score a run opens on, from js/game_manager.js L6. */
const OPENING_SCORE = 0;

/** Separator between a fact's label and its value. */
const LABEL_SEPARATOR = ' ';

/**
 * Every string this screen renders, as pure functions of primitives.
 *
 * The stage number is one-based: it is player-facing copy, and the engine's
 * own index stays zero-based everywhere else. No string here names a movement
 * control, so none can fall out of step with the instructional copy of
 * index.html.
 */
export const stageProgressCopy = Object.freeze({
  /** Heading for a stage whose goal was met. */
  clearedHeading: (stage: number): string => `Stage ${String(stage)} cleared`,

  /** Heading for a stage that ended with its goal unmet. */
  unclearedHeading: (stage: number): string => `Stage ${String(stage)} ended`,

  /** Label ahead of the goal readout. */
  goalLabel: 'Goal',

  /** Renders a `'highest-tile'` target. */
  tileTarget: (target: number): string => `tile ${String(target)}`,

  /** Renders a `'score-threshold'` target. */
  scoreTarget: (target: number): string => `${String(target)} score`,

  /** Renders the measured tile of a `'highest-tile'` goal. */
  tileAchieved: (achieved: number): string => `reached ${String(achieved)}`,

  /** Renders the measured score of a `'score-threshold'` goal. */
  scoreAchieved: (achieved: number): string => `scored ${String(achieved)}`,

  /** Rendered where the stage carried no goal. */
  goalAbsent: 'none in force',

  /** Joins a target to the quantity measured against it. */
  goalMeasured: (target: string, achieved: string): string =>
    `${target}, ${achieved}`,

  /** Label ahead of the score at stage end. */
  scoreLabel: 'Score',

  /** Renders the score at stage end. */
  scoreValue: (score: number): string => String(score),

  /** Label ahead of the goal fraction. */
  progressLabel: 'Progress',

  /**
   * Renders the goal fraction as a percentage of the target.
   *
   * The fraction reaches the snapshot verbatim; this states it as a whole
   * percentage and applies no bound of its own, `evaluateStageGoal` having
   * already bounded it to the closed interval [0, 1].
   */
  progressValue: (percent: number): string =>
    `${String(percent)}% of the goal`,

  /** Visible label of the continue control. */
  continueLabel: 'Continue',

  /**
   * Accessible name of the continue control: it names the destination and
   * contains the visible label, which is what WCAG 2.5.3 requires of an
   * extended name.
   */
  continueName: 'Continue to the relic reward',
});

/** The copy set, as a type a caller can partially override. */
export type StageProgressCopy = typeof stageProgressCopy;

/** Counter raised once per completed mount. */
const MOUNTED_METRIC = 'ui.stageProgress.mounted';

/** Counter raised once per mount that resolved no container. */
const MOUNT_MISSING_METRIC = 'ui.stageProgress.mount_missing';

/** Counter raised once per entry that rendered the interstitial. */
const ENTERED_METRIC = 'ui.stageProgress.entered';

/** Counter raised once per refresh that changed what is on screen. */
const UPDATED_METRIC = 'ui.stageProgress.updated';

/** Counter raised once per refresh that found nothing to change. */
const UNCHANGED_METRIC = 'ui.stageProgress.unchanged';

/** Counter raised once per exit from the state. */
const LEFT_METRIC = 'ui.stageProgress.left';

/** Counter raised once per announcement written. */
const ANNOUNCED_METRIC = 'ui.stageProgress.announced';

/** Counter raised once per continue press this module forwarded. */
const CONTINUE_METRIC = 'ui.stageProgress.continue';

/**
 * Counter raised once per goal measurement that was refused or unavailable.
 */
const MEASURE_SKIPPED_METRIC = 'ui.stageProgress.measure_skipped';

/** Counter raised once per injected port that raised. */
const PORT_FAULT_METRIC = 'ui.stageProgress.port_faulted';

/** Counter raised once per call that reaches an unmounted screen. */
const CALL_AFTER_UNMOUNT_METRIC = 'ui.stageProgress.call_after_unmount';

/** Counter raised once per lifecycle call carrying another state's context. */
const CONTEXT_REJECTED_METRIC = 'ui.stageProgress.context_rejected';

/** Counter raised once per continue callback that raised. */
const CONTINUE_FAULT_METRIC = 'ui.stageProgress.continue_faulted';

/** Counter raised once per `unmount`. */
const UNMOUNTED_METRIC = 'ui.stageProgress.unmounted';

/**
 * The run accessors this screen reads.
 *
 * Declared as the accessor triple of `RunController` in
 * ../../run/run-controller made optional, so that controller satisfies it as
 * it stands and a test substitutes a plain object. Structurally a subset of
 * the `RouterRunPort` of ../screen-router, so one adapter serves both.
 *
 * `goalProgress` returns the `progress` member `evaluateStageGoal` produced,
 * already bounded to [0, 1] by it and stored verbatim there.
 */
export type StageProgressRunPort = Partial<
  Pick<RunController, 'stageIndex' | 'stageGoal' | 'goalProgress'>
>;

/**
 * The full goal measurement, where a caller holds one.
 *
 * Supplied by a composition that measured the goal against the board, which is
 * the only place the highest tile value is known, so `achieved` reaches the
 * screen without it reading engine state.
 */
export interface StageProgressMeasurementPort {
  /** The measurement in force, or `null` where none was taken. */
  progress?(): StageGoalProgress | null;

  /**
   * The highest tile value on the board at stage end, for the case where the
   * caller can supply that quantity but not a whole measurement.
   */
  highestTileValue?(): number | null;
}

/**
 * The announcer the stage clear is written through.
 *
 * Structurally the `RouterAnnouncerPort` of ../screen-router, and the
 * `LiveRegionAnnouncer` of ../a11y/live-region satisfies it as it stands.
 */
export interface StageProgressAnnouncerPort {
  announce?(input: Announcement): void;
}

/**
 * The preference read before focus is placed. The `PreferenceStore` of
 * ../a11y/settings satisfies it as it stands.
 */
export type StageProgressPreferencePort = Partial<
  Pick<PreferenceStore, 'isReducedMotion'>
>;

/** Everything the factory accepts. Every member is optional. */
export interface StageProgressOptions {
  /**
   * The container, as an element or as a selector resolved against `document`.
   *
   * A screen driven by the router receives the resolved container through
   * `mount` and needs none of this; the fallback exists so the screen is
   * usable stand-alone, and it runs through the guarded `resolveMount` of
   * ../a11y/settings. Defaults to `SCREEN_MOUNTS.stageClear`.
   */
  readonly host?: Element | string | null;

  /** Document nodes are created in. Defaults to the ambient document. */
  readonly document?: Document | null;

  /** The run accessors. Absent members yield no value and are not called. */
  readonly run?: StageProgressRunPort;

  /** The goal measurement, where the caller holds one. */
  readonly measurement?: StageProgressMeasurementPort;

  /** The announcer the stage clear is written through. */
  readonly announcer?: StageProgressAnnouncerPort;

  /** The preference source read before focus is placed. */
  readonly preferences?: StageProgressPreferencePort;

  /** Called when the continue control is activated. */
  readonly onContinue?: () => void;

  /** Copy overrides. Any member may be replaced. */
  readonly copy?: Partial<StageProgressCopy>;

  /** Whether focus is placed on entry. Defaults to `true`. */
  readonly placeFocus?: boolean;

  /**
   * Whether this screen announces the stage clear on entry. Defaults to `true`.
   *
   * `false` is for a composition whose router reads the entry line, which it
   * takes from `announcement()` below — the same words in a form free text
   * can carry. Decision DL-STAGECLEAR-05.
   */
  readonly announceEntry?: boolean;

  /** Sink every miss, every write and every skipped write reports through. */
  readonly reporter?: UiReporter;
}

/** The measured quantity and the fraction, as this screen resolved them. */
export interface StageProgressMeasurement {
  /**
   * The quantity measured against the target — the highest tile value for a
   * `'highest-tile'` goal, the score for a `'score-threshold'` goal — and
   * `null` where no source supplied it.
   */
  readonly achieved: number | null;

  /**
   * The goal fraction, carried verbatim from its source and never re-bounded
   * here, and `null` where no source supplied a usable one.
   */
  readonly progress: number | null;
}

/** What one render put on screen, as plain data. */
export interface StageProgressSnapshot {
  /** Zero-based index of the stage that ended, as the payload carried it. */
  readonly stageIndex: number;

  /** One-based stage number shown, which is the index plus one. */
  readonly stage: number;

  /** Whether the goal was met, as the payload carried it. */
  readonly cleared: boolean;

  /** The score at stage end, as the payload carried it. */
  readonly score: number;

  /** The goal's discriminant, and `null` where no goal was in force. */
  readonly goalKind: StageGoal['kind'] | null;

  /** The goal's target, and `null` where no goal was in force. */
  readonly target: number | null;

  /** The measured quantity and the goal fraction, both possibly absent. */
  readonly measurement: StageProgressMeasurement;

  /** The heading written, which is the whole of that element's text. */
  readonly heading: string;

  /** The value written into the goal line, beside its own label element. */
  readonly goalText: string;

  /** The value written into the score line, beside its own label element. */
  readonly scoreText: string;

  /**
   * The value written into the progress line, and `null` where no fraction was
   * available and the line is therefore down.
   */
  readonly progressText: string | null;

  /** Whether this render announced the clear. */
  readonly announced: boolean;

  /** The stacking slot this screen occupies, from `STAGE_PROGRESS_LAYER`. */
  readonly layer: number;
}

/**
 * The mounted screen: the five members of the `Screen` lifecycle of
 * ../screen-router, plus the read-only surface a caller and a test inspect it
 * through. Every member is safe to call at any time and in any order.
 */
export interface StageProgressScreen extends Screen {
  /** What the last render put on screen, or `null` before the first. */
  readRendered(): StageProgressSnapshot | null;

  /** Whether a container resolved. */
  hasHost(): boolean;

  /** Whether this screen's content is currently in the container. */
  isPresented(): boolean;

  /** The continue control, for a caller that binds or focuses it. */
  readContinueControl(): HTMLElement | null;
}


/**
 * The ambient document, where there is one.
 *
 * @returns The document, or `null` outside a document context.
 */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Narrows an element to the HTML element whose attributes this module writes.
 *
 * @param element Element to narrow.
 * @returns The element, or `null` where it carries no `classList` to write.
 */
function asHtmlElement(element: Element): HTMLElement | null {
  return 'classList' in element ? (element as HTMLElement) : null;
}

/**
 * Resolves the copy set, member by member.
 *
 * @param overrides Replacements, any subset.
 * @returns The default set where there are none, and a frozen merge
 *   otherwise.
 */
function mergeCopy(
  overrides: Partial<StageProgressCopy> | undefined,
): StageProgressCopy {
  if (overrides === undefined) {
    return stageProgressCopy;
  }

  return Object.freeze({
    clearedHeading:
      overrides.clearedHeading ?? stageProgressCopy.clearedHeading,
    unclearedHeading:
      overrides.unclearedHeading ?? stageProgressCopy.unclearedHeading,
    goalLabel: overrides.goalLabel ?? stageProgressCopy.goalLabel,
    tileTarget: overrides.tileTarget ?? stageProgressCopy.tileTarget,
    scoreTarget: overrides.scoreTarget ?? stageProgressCopy.scoreTarget,
    tileAchieved: overrides.tileAchieved ?? stageProgressCopy.tileAchieved,
    scoreAchieved: overrides.scoreAchieved ?? stageProgressCopy.scoreAchieved,
    goalAbsent: overrides.goalAbsent ?? stageProgressCopy.goalAbsent,
    goalMeasured: overrides.goalMeasured ?? stageProgressCopy.goalMeasured,
    scoreLabel: overrides.scoreLabel ?? stageProgressCopy.scoreLabel,
    scoreValue: overrides.scoreValue ?? stageProgressCopy.scoreValue,
    progressLabel: overrides.progressLabel ?? stageProgressCopy.progressLabel,
    progressValue: overrides.progressValue ?? stageProgressCopy.progressValue,
    continueLabel: overrides.continueLabel ?? stageProgressCopy.continueLabel,
    continueName: overrides.continueName ?? stageProgressCopy.continueName,
  });
}

/**
 * Whether a value is a finite number.
 *
 * @param value Candidate.
 * @returns Whether it is a number this module will do arithmetic on.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whether a value is a goal fraction this screen will render.
 *
 * @param value Candidate fraction.
 * @returns Whether it is finite and within [0, 1].
 */
function isRenderableFraction(value: unknown): value is number {
  return (
    isFiniteNumber(value) &&
    value >= FRACTION_FLOOR &&
    value <= FRACTION_CEILING
  );
}

/**
 * Whether a value carries the three members of `StageGoalProgress`.
 *
 * @param value Candidate measurement.
 * @returns Whether every member is present and of the declared type.
 */
function isStageGoalProgress(value: unknown): value is StageGoalProgress {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<StageGoalProgress>;

  return (
    isFiniteNumber(candidate.achieved) &&
    typeof candidate.progress === 'number' &&
    typeof candidate.cleared === 'boolean'
  );
}

/**
 * Calls one injected accessor, contained.
 *
 * @param member Name carried into the report.
 * @param read The accessor, already bound to its owner.
 * @param reporter Contained sink.
 * @returns The value, or `null`.
 */
function readPort<T>(
  member: string,
  read: (() => T) | undefined,
  reporter: UiReporter,
): T | null {
  if (typeof read !== 'function') {
    return null;
  }

  try {
    return read();
  } catch (error) {
    reporter.count(PORT_FAULT_METRIC, { member });
    reporter.error('a stage progress port raised', error, {
      context: REPORT_CONTEXT,
      member,
    });

    return null;
  }
}

/**
 * Renders the goal readout, branching on the `kind` discriminant of
 * `StageGoal` rather than assuming one form: a tile target and a score target
 * read differently, and each is joined to the quantity measured against it
 * where one is known.
 *
 * @param goal The goal in force, or `null` where the stage carried none.
 * @param achieved The measured quantity, or `null` where none was supplied.
 * @param copy The copy set in force.
 * @returns The line, which is never empty.
 */
export function describeStageGoal(
  goal: StageGoal | null,
  achieved: number | null,
  copy: StageProgressCopy = stageProgressCopy,
): string {
  if (goal === null) {
    return copy.goalAbsent;
  }

  switch (goal.kind) {
    case 'highest-tile': {
      const target = copy.tileTarget(goal.target);

      return achieved === null
        ? target
        : copy.goalMeasured(target, copy.tileAchieved(achieved));
    }

    case 'score-threshold': {
      const target = copy.scoreTarget(goal.target);

      return achieved === null
        ? target
        : copy.goalMeasured(target, copy.scoreAchieved(achieved));
    }

    default: {
      const unhandledGoal: never = goal;

      void unhandledGoal;

      return copy.goalAbsent;
    }
  }
}

/** Where a resolved measurement came from. */
export type StageProgressMeasurementSource =
  | 'measurement-port'
  | 'evaluated'
  | 'fraction-port'
  | 'none';

/** A resolved measurement and the source that supplied it. */
export interface StageProgressMeasurementResult
  extends StageProgressMeasurement {
  readonly source: StageProgressMeasurementSource;
}

/** The quantities a measurement is resolved from. */
export interface StageProgressMeasurementSources {
  /** A whole measurement a caller already holds. */
  readonly measurement?: StageGoalProgress | null;

  /** The goal fraction alone, as `RunController.goalProgress` returns it. */
  readonly fraction?: number | null;

  /** The highest tile value on the board at stage end. */
  readonly highestTileValue?: number | null;
}

/**
 * Resolves the measured quantity and the goal fraction, in a fixed order.
 *
 * Deterministic: identical arguments always produce a deep-equal result, and
 * nothing here reads a clock or consumes randomness.
 *
 * @param facts The three members of the `stage:end` payload.
 * @param goal The goal in force, or `null`.
 * @param sources The quantities available.
 * @param reporter Contained sink for a refused evaluation.
 * @returns The measurement and the source that supplied it.
 */
export function measureStageProgress(
  facts: StageEndEvent,
  goal: StageGoal | null,
  sources: StageProgressMeasurementSources = {},
  reporter: UiReporter = NOOP_UI_REPORTER,
): StageProgressMeasurementResult {
  const supplied = sources.measurement;

  if (isStageGoalProgress(supplied)) {
    return {
      achieved: supplied.achieved,
      progress: isRenderableFraction(supplied.progress)
        ? supplied.progress
        : null,
      source: 'measurement-port',
    };
  }

  const fraction = isRenderableFraction(sources.fraction)
    ? sources.fraction
    : null;
  const highest = sources.highestTileValue;
  const hasHighest = isFiniteNumber(highest);

  // A `'score-threshold'` goal takes its `achieved` from the score, which the
  // payload carries, so it is measurable with no board quantity at all.
  if (goal !== null && (goal.kind === 'score-threshold' || hasHighest)) {
    try {
      const evaluated = evaluateStageGoal(goal, {
        score: facts.score,

        // Not read for a `'score-threshold'` goal, whose `achieved` comes from
        // the score above; the neutral 0 stands in only on that branch.
        highestTileValue: hasHighest ? highest : FRACTION_FLOOR,
      });

      return {
        achieved: evaluated.achieved,
        progress: isRenderableFraction(evaluated.progress)
          ? evaluated.progress
          : null,
        source: 'evaluated',
      };
    } catch (error) {
      reporter.count(MEASURE_SKIPPED_METRIC, { reason: 'raised' });
      reporter.error('the stage goal could not be formatted', error, {
        context: REPORT_CONTEXT,
        kind: goal.kind,
      });
    }
  }

  return {
    achieved: null,
    progress: fraction,
    source: fraction === null ? 'none' : 'fraction-port',
  };
}

/**
 * States a goal fraction as a whole percentage.
 *
 * @param fraction The validated fraction.
 * @returns The percentage, as a whole number.
 */
function asPercent(fraction: number): number {
  return Math.round(fraction * PERCENT_SCALE);
}

/**
 * The four strings one render writes, joined into one comparable value, so a
 * refresh that would write exactly what is already on screen writes nothing.
 *
 * @param snapshot The render to describe.
 * @returns A value equal for two renders that put the same text on screen.
 */
function renderSignature(snapshot: StageProgressSnapshot): string {
  return [
    snapshot.heading,
    snapshot.goalText,
    snapshot.scoreText,
    snapshot.progressText ?? '',
  ].join('\u001f');
}


/**
 * Whether a value carries a `StageGoal`'s discriminant and a finite target.
 *
 * @param value Candidate goal.
 * @returns Whether it is a goal this screen will render.
 */
function isStageGoal(value: unknown): value is StageGoal {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { kind?: unknown; target?: unknown };

  return (
    (candidate.kind === 'highest-tile' ||
      candidate.kind === 'score-threshold') &&
    isFiniteNumber(candidate.target)
  );
}

/**
 * One labelled fact: its paragraph, and the node its value is written into.
 */
interface FactNodes {
  readonly paragraph: HTMLElement;
  readonly value: Text;
}

/**
 * Every node this module owns. `all` is the append and remove set, in the
 * order the container lays them out, so `leave` and `unmount` take away
 * exactly what `mount` created and nothing the container held already.
 *
 * CHANGED: `all` is the panel alone, and the five content nodes are its
 * children rather than the container's. DL-STAGECLEAR-06.
 */
interface StageProgressNodes {
  /** The bounded reading surface every content node sits on. */
  readonly panel: HTMLElement;

  readonly heading: HTMLElement;
  readonly goal: FactNodes;
  readonly score: FactNodes;
  readonly progress: FactNodes;
  readonly actions: HTMLElement;
  readonly control: HTMLElement;
  readonly all: readonly Element[];
}

/**
 * Mounts the stage-clear interstitial.
 *
 * Nothing is read or written at import time: the one guarded container lookup,
 * every node creation and every report happen inside this call and the
 * lifecycle members it returns. An absent container is reported and every
 * write is skipped; the screen stays callable and answers `hasHost` with
 * `false`.
 *
 * @param options Container, document, ports, copy, focus switch and sink.
 * @returns The mounted screen, whether or not a container resolved.
 * @example
 * ```ts
 * const stageProgress = createStageProgressScreen({
 *   run: runController,
 *   onContinue: (): void => {
 *     router.send('stageEnd');
 *   },
 * });
 *
 * const router = createScreenRouter({
 *   screens: { stageClear: stageProgress },
 * });
 * ```
 */
export function createStageProgressScreen(
  options: StageProgressOptions = {},
): StageProgressScreen {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const copy = mergeCopy(options.copy);
  const placeFocusOnEntry = options.placeFocus !== false;
  const announceOnEntry = options.announceEntry !== false;
  const run = options.run;
  const measurementPort = options.measurement;
  const announcer = options.announcer;
  const preferences = options.preferences;
  const onContinue = options.onContinue;

  let host: Element | null = null;
  let owner: Document | null = null;
  let nodes: StageProgressNodes | null = null;
  let presented = false;
  let listening = false;
  let unmounted = false;
  let rendered: StageProgressSnapshot | null = null;
  let signature: string | null = null;
  let announcedThisVisit = false;

  /**
   * Resolves one selector, guarded, against the document in force.
   *
   * @param selector Selector to resolve.
   * @returns The element, or `null` with the miss already reported.
   */
  const lookup = (selector: string): Element | null => {
    const root = options.document ?? readAmbientDocument();

    return resolveMount<HTMLElement>(selector, {
      name: HOST_MOUNT,
      ...(root === null ? {} : { root }),
      reporter,
      context: REPORT_CONTEXT,
    });
  };

  /**
   * The container a caller supplied, or the one index.html declares.
   *
   * @returns The element, or `null` with the miss already reported.
   */
  const resolveSuppliedHost = (): Element | null => {
    const supplied = options.host;

    if (supplied === undefined || supplied === null) {
      return lookup(HOST_SELECTOR);
    }

    return typeof supplied === 'string' ? lookup(supplied) : supplied;
  };

  /**
   * The document nodes are created in: the injected one, then the container's
   * own, then the ambient one.
   *
   * @param candidate Container the nodes will be appended to.
   * @returns The document, or `null` where there is none.
   */
  const readOwnerDocument = (candidate: Element): Document | null => {
    const supplied = options.document;

    if (supplied !== undefined && supplied !== null) {
      return supplied;
    }

    return candidate.ownerDocument ?? readAmbientDocument();
  };

  /**
   * Builds one labelled fact. The value lives in its own text node, so a write
   * replaces the value and never the label beside it.
   *
   * @param doc Document the nodes are created in.
   * @param label Text of the bold label.
   * @returns The paragraph and its value node.
   */
  const createFact = (doc: Document, label: string): FactNodes => {
    const paragraph = doc.createElement('p');

    paragraph.className = SCREEN_CLASSES.text;

    const labelNode = doc.createElement('span');

    labelNode.className = SCREEN_CLASSES.label;
    labelNode.textContent = label;

    const value = doc.createTextNode('');

    paragraph.append(labelNode, doc.createTextNode(LABEL_SEPARATOR), value);

    return { paragraph, value };
  };

  /**
   * Builds the whole content once.
   *
   * @param doc Document the nodes are created in.
   * @returns Every node this module owns.
   */
  const buildNodes = (doc: Document): StageProgressNodes => {
    // ADDED: the surface, built first and appended last, so the five content
    // nodes below are laid out on it rather than on the container's tint.
    // DL-STAGECLEAR-06.
    const panel = doc.createElement('div');

    panel.className = SCREEN_CLASSES.panel;

    const heading = doc.createElement('h2');

    heading.className = SCREEN_CLASSES.verdict;

    const goal = createFact(doc, copy.goalLabel);
    const score = createFact(doc, copy.scoreLabel);
    const progress = createFact(doc, copy.progressLabel);

    // Down until a fraction is available, so no line ever states a quantity no
    // source produced.
    progress.paragraph.hidden = true;

    const actions = doc.createElement('div');

    actions.className = SCREEN_CLASSES.actions;


    // A REAL BUTTON: focusable, activated by Enter and by Space through the
    // one `click` a native button dispatches for both, and announced as a
    // button with no ARIA role.
    const control = doc.createElement('button');

    control.type = 'button';
    control.className = `${SCREEN_CLASSES.button} ${CONTINUE_CONTROL_CLASS}`;
    control.textContent = copy.continueLabel;

    // The accessible name states where the control leads and contains the
    // visible label, which is what WCAG 2.5.3 requires of an extended name.
    control.setAttribute('aria-label', copy.continueName);

    control.setAttribute(FOCUS_INITIAL_ATTRIBUTE, '');

    actions.append(control);

    panel.append(
      heading,
      goal.paragraph,
      score.paragraph,
      progress.paragraph,
      actions,
    );

    return {
      panel,
      heading,
      goal,
      score,
      progress,
      actions,
      control,

      // The panel alone: it holds the other five, so appending and removing it
      // appends and removes all of them.
      all: Object.freeze([panel]),
    };
  };

  /**
   * Forwards one continue press to the injected callback.
   *
   * Delegated on the container and matched against this module's own control,
   * so a press on anything else in the container is ignored. The callback is
   * contained: one that raises is reported and the press ends there.
   *
   * @param event The `click` the container received.
   */
  const readContinuePress = (event: Event): void => {
    if (onContinue === undefined) {
      return;
    }

    const target = event.target;

    if (target === null || typeof target !== 'object') {
      return;
    }

    const closest = (target as { closest?: (s: string) => Element | null })
      .closest;

    if (typeof closest !== 'function') {
      return;
    }

    const pressed = closest.call(target as Element, CONTINUE_CONTROL_SELECTOR);

    if (pressed === null || nodes === null || pressed !== nodes.control) {
      return;
    }

    reporter.count(CONTINUE_METRIC);

    try {
      onContinue();
    } catch (error) {
      reporter.count(CONTINUE_FAULT_METRIC);
      reporter.error('the continue callback raised', error, {
        context: REPORT_CONTEXT,
      });
    }
  };

  /** Binds the one delegated listener, where a callback was supplied. */
  const attachListener = (): void => {
    if (listening || host === null || onContinue === undefined) {
      return;
    }

    host.addEventListener('click', readContinuePress);
    listening = true;
  };

  /** Removes the one delegated listener from the container it is on. */
  const detachListener = (): void => {
    if (!listening || host === null) {
      return;
    }

    host.removeEventListener('click', readContinuePress);
    listening = false;
  };

  /** Appends this module's nodes, once. */
  const present = (): void => {
    if (presented || host === null || nodes === null) {
      return;
    }

    host.append(...nodes.all);
    presented = true;
  };

  /** Takes this module's nodes away, and nothing else. */
  const withdraw = (): void => {
    if (!presented || nodes === null) {
      return;
    }

    for (const node of nodes.all) {
      node.remove();
    }

    presented = false;
  };


  /**
   * Takes a container on: caches it, builds this module's nodes against its
   * document and binds the one delegated listener. Called once from `mount`
   * and as the fallback from `enter`, and idempotent for a container already
   * held.
   *
   * @param candidate The container, or `null` where none resolved.
   * @returns Whether a container and a document are both in hand afterwards.
   */
  const adoptHost = (candidate: Element | null): boolean => {
    if (candidate === null) {
      reporter.count(MOUNT_MISSING_METRIC, { mount: HOST_MOUNT });

      return false;
    }

    if (host === candidate && nodes !== null && owner !== null) {
      return true;
    }

    // A different container replaces the one held: the nodes leave the old one
    // and the listener comes off it before either is re-established.
    if (host !== null && host !== candidate) {
      withdraw();
      detachListener();
    }

    host = candidate;

    const resolved = readOwnerDocument(candidate);

    if (resolved === null) {
      reporter.count(MOUNT_MISSING_METRIC, {
        mount: HOST_MOUNT,
        reason: 'no-document',
      });
      reporter.log('warn', 'stage progress has no document to build in', {
        context: REPORT_CONTEXT,
      });

      return false;
    }

    // Rebuilt where the document changed: a node belongs to the document that
    // created it.
    if (nodes === null || owner !== resolved) {
      withdraw();
      nodes = buildNodes(resolved);
    }

    owner = resolved;
    attachListener();

    return true;
  };

  /**
   * Ensures a container, its document and this module's nodes are in hand.
   *
   * The router's own container is preferred; a caller-supplied one, or the
   * selector index.html declares, is the fallback for a screen driven with no
   * router.
   *
   * @param context The context in force.
   * @returns Whether the screen can write.
   */
  const ensureHost = (context: StageClearScreenContext): boolean => {
    if (host !== null && nodes !== null && owner !== null) {
      return true;
    }

    return adoptHost(context.host ?? resolveSuppliedHost());
  };

  /**
   * Narrows a lifecycle argument to this screen's own context.
   *
   * @param context The context received.
   * @param member Lifecycle member, carried into the report.
   * @returns The context, or `null` where it belongs to another state.
   */
  const asStageClear = (
    context: ScreenContext,
    member: string,
  ): StageClearScreenContext | null => {
    if (context !== null && context.screen === SCREEN_NAME) {
      return context;
    }

    reporter.count(CONTEXT_REJECTED_METRIC, { member });
    reporter.log('warn', 'stage progress received another screen context', {
      context: REPORT_CONTEXT,
      member,
      screen: context === null ? 'none' : String(context.screen),
    });

    return null;
  };

  /**
   * The stage index shown: the payload's own, then the run port's.
   *
   * @param context The context in force.
   * @returns A finite zero-based index.
   */
  const readStageIndex = (context: StageClearScreenContext): number => {
    if (isFiniteNumber(context.stageIndex)) {
      return context.stageIndex;
    }

    const fromPort = readPort(
      'stageIndex',
      run?.stageIndex?.bind(run),
      reporter,
    );

    return isFiniteNumber(fromPort) ? fromPort : FIRST_STAGE_INDEX;
  };

  /**
   * The goal shown: the payload's own, then the run port's.
   *
   * @param context The context in force.
   * @returns The goal, or `null` where no source carried one.
   */
  const readStageGoal = (
    context: StageClearScreenContext,
  ): StageGoal | null => {
    if (isStageGoal(context.goal)) {
      return context.goal;
    }

    const fromPort = readPort('stageGoal', run?.stageGoal?.bind(run), reporter);

    return isStageGoal(fromPort) ? fromPort : null;
  };

  /**
   * The effective reduced-motion value: the preference port's answer, then the
   * value the router read at the moment of the transition.
   *
   * @param context The context in force.
   * @returns Whether motion is to be reduced.
   */
  const readReducedMotion = (context: StageClearScreenContext): boolean => {
    const fromPort = readPort(
      'isReducedMotion',
      preferences?.isReducedMotion?.bind(preferences),
      reporter,
    );

    return typeof fromPort === 'boolean' ? fromPort : context.reducedMotion;
  };

  /**
   * Resolves everything one render writes.
   *
   * `stageIndex`, `cleared` and `score` are the three members of the
   * `stage:end` payload; the goal is the `StageGoal` beside them; and the
   * measurement is resolved by `measureStageProgress` from the injected ports.
   *
   * @param context The context in force.
   * @returns The render, with `announced` still `false`.
   */
  const buildSnapshot = (
    context: StageClearScreenContext,
  ): StageProgressSnapshot => {
    const facts: StageEndEvent = {
      stageIndex: readStageIndex(context),
      cleared: context.cleared === true,
      score: isFiniteNumber(context.score) ? context.score : OPENING_SCORE,
    };
    const goal = readStageGoal(context);
    const measured = measureStageProgress(
      facts,
      goal,
      {
        measurement: readPort(
          'progress',
          measurementPort?.progress?.bind(measurementPort),
          reporter,
        ),
        fraction: readPort(
          'goalProgress',
          run?.goalProgress?.bind(run),
          reporter,
        ),
        highestTileValue: readPort(
          'highestTileValue',
          measurementPort?.highestTileValue?.bind(measurementPort),
          reporter,
        ),
      },
      reporter,
    );

    if (measured.progress === null) {
      reporter.count(MEASURE_SKIPPED_METRIC, { reason: measured.source });
    }

    const stage = facts.stageIndex + STAGE_NUMBER_OFFSET;

    return {
      stageIndex: facts.stageIndex,
      stage,
      cleared: facts.cleared,
      score: facts.score,
      goalKind: goal === null ? null : goal.kind,
      target: goal === null ? null : goal.target,
      measurement: {
        achieved: measured.achieved,
        progress: measured.progress,
      },
      heading: facts.cleared
        ? copy.clearedHeading(stage)
        : copy.unclearedHeading(stage),
      goalText: describeStageGoal(goal, measured.achieved, copy),
      scoreText: copy.scoreValue(facts.score),
      progressText:
        measured.progress === null
          ? null
          : copy.progressValue(asPercent(measured.progress)),
      announced: false,
      layer: STAGE_PROGRESS_LAYER,
    };
  };

  /**
   * Writes one render into the cached nodes.
   *
   * Values go into their own text nodes and the heading into its own element,
   * so nothing here creates or replaces a node and a repeated write cannot
   * duplicate one.
   *
   * @param snapshot The render to write.
   */
  const write = (snapshot: StageProgressSnapshot): void => {
    if (nodes === null) {
      return;
    }

    nodes.heading.textContent = snapshot.heading;
    nodes.goal.value.data = snapshot.goalText;
    nodes.score.value.data = snapshot.scoreText;

    if (snapshot.progressText === null) {
      nodes.progress.value.data = '';
      nodes.progress.paragraph.hidden = true;
    } else {
      nodes.progress.value.data = snapshot.progressText;
      nodes.progress.paragraph.hidden = false;
    }
  };

  /**
   * Writes the stage clear to the live region, through the injected announcer.
   *
   * @param snapshot The render being announced.
   * @returns Whether a line was written.
   */
  const announceClear = (snapshot: StageProgressSnapshot): boolean => {
    const port = announcer;

    if (port === undefined) {
      return false;
    }

    const announce = port.announce;

    if (typeof announce !== 'function') {
      return false;
    }

    const line: Announcement = {
      kind: 'stageClear',
      stageIndex: snapshot.stageIndex,
      cleared: snapshot.cleared,
    };

    try {
      announce.call(port, line);
    } catch (error) {
      reporter.count(PORT_FAULT_METRIC, { member: 'announce' });
      reporter.error('the stage clear could not be announced', error, {
        context: REPORT_CONTEXT,
      });

      return false;
    }

    reporter.count(ANNOUNCED_METRIC, { cleared: snapshot.cleared });

    return true;
  };

  /**
   * Places focus deterministically, on the control carrying the marker
   * attribute. The motion value gates the scroll that follows the placement,
   * which is the one entrance behaviour this screen sequences.
   *
   * @param context The context in force.
   */
  const placeFocus = (context: StageClearScreenContext): void => {
    if (!placeFocusOnEntry || host === null) {
      return;
    }

    focusInitial(SCREEN_NAME, host, {
      reporter,
      context: REPORT_CONTEXT,
      reducedMotion: readReducedMotion(context),
    });
  };

  /**
   * Whether a lifecycle call may proceed.
   *
   * @param member Lifecycle member, carried into the report.
   * @returns Whether the screen is still mounted.
   */
  const isLive = (member: string): boolean => {
    if (!unmounted) {
      return true;
    }

    reporter.count(CALL_AFTER_UNMOUNT_METRIC, { member });

    return false;
  };

  return Object.freeze({
    mount(hostElement: Element): void {
      if (!isLive('mount')) {
        return;
      }

      if (!adoptHost(hostElement)) {
        return;
      }

      reporter.count(MOUNTED_METRIC);
      reporter.log('debug', 'stage progress mounted', {
        context: REPORT_CONTEXT,
        selector: HOST_SELECTOR,
      });
    },

    /**
     * The line the router reads on entry: the verdict, the goal and the score
     * this screen is showing, as free text.
     *
     * The router is the one speaker of an entry announcement, so the words are
     * supplied here rather than spoken from `enter`. Decision DL-STAGECLEAR-05.
     *
     * @param context The context the entry carried.
     * @returns The line, or `null` for any other state.
     */
    announcement(context: ScreenContext): string | null {
      const entered = asStageClear(context, 'announcement');

      if (entered === null) {
        return null;
      }

      const snapshot = buildSnapshot(entered);
      const heading = snapshot.cleared
        ? copy.clearedHeading(snapshot.stageIndex + 1)
        : copy.unclearedHeading(snapshot.stageIndex + 1);

      return `${heading}. ${copy.scoreLabel} ${copy.scoreValue(
        snapshot.score,
      )}. ${copy.continueName}.`;
    },

    enter(context: ScreenContext): void {
      if (!isLive('enter')) {
        return;
      }

      const entered = asStageClear(context, 'enter');

      if (entered === null || !ensureHost(entered)) {
        return;
      }

      present();

      const snapshot = buildSnapshot(entered);

      write(snapshot);
      signature = renderSignature(snapshot);

      // Once per visit. `update` announces nothing, and the latch is released
      // by `leave`, so a refresh cannot repeat the line and a second visit is
      // announced again. A composition whose router reads the entry line leaves
      // `announceEntry` off and this speaks nothing. DL-STAGECLEAR-05.
      const spoken =
        announcedThisVisit || !announceOnEntry
          ? false
          : announceClear(snapshot);

      if (spoken) {
        announcedThisVisit = true;
      }

      rendered = Object.freeze({ ...snapshot, announced: spoken });

      placeFocus(entered);

      reporter.count(ENTERED_METRIC, { cleared: snapshot.cleared });
    },

    update(context: ScreenContext): void {
      if (!isLive('update')) {
        return;
      }

      const refreshed = asStageClear(context, 'update');

      if (refreshed === null || !ensureHost(refreshed)) {
        return;
      }

      present();

      const snapshot = buildSnapshot(refreshed);
      const next = renderSignature(snapshot);

      // IDEMPOTENT. A refresh carrying the same values writes nothing, places
      // no focus and announces nothing, so a repeated `update` in one visit
      // leaves the interstitial exactly as it stands.
      if (next === signature) {
        reporter.count(UNCHANGED_METRIC);

        return;
      }

      write(snapshot);
      signature = next;
      rendered = Object.freeze({ ...snapshot, announced: false });

      reporter.count(UPDATED_METRIC);
    },

    leave(): void {
      if (!isLive('leave')) {
        return;
      }

      withdraw();

      // Released so the next visit renders from nothing and announces once
      // more; the last render stays readable through `readRendered`.
      signature = null;
      announcedThisVisit = false;

      reporter.count(LEFT_METRIC);
    },

    unmount(): void {
      if (!isLive('unmount')) {
        return;
      }

      unmounted = true;

      withdraw();
      detachListener();

      host = null;
      owner = null;
      nodes = null;
      signature = null;
      announcedThisVisit = false;

      reporter.count(UNMOUNTED_METRIC);
    },

    readRendered: (): StageProgressSnapshot | null => rendered,

    hasHost: (): boolean => host !== null,

    isPresented: (): boolean => presented,

    readContinueControl: (): HTMLElement | null =>
      nodes === null ? null : asHtmlElement(nodes.control),
  });
}
