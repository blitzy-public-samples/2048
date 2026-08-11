// The run summary: the end-of-run panel the `runSummary` state renders —
// final score, stage reached with its goal, the relics collected in pickup
// order, and the run seed, displayed verbatim and offered for copying.
//
// INPUT CONTRACT
//   `RunSummary` of src/run/run-state.ts, which names this module as the
//   renderer of that shape. That declaration carries data only and states that
//   presentation, copying the seed included, belongs to the presenting screen.
//   `RunSummary.relics` arrives IN PICKUP ORDER and is rendered in the order
//   supplied. `RelicRegistry.active()` of src/relics/relic-registry.ts is the
//   authority for that order and assigns the `pickupOrder` each row's slot is
//   read from; no member here sorts, groups, filters or reverses it.
//
// WHAT IT OWNS
//   the element tree inside `#screen-run-summary`, which index.html declares
//   empty;
//   the three readouts, the relic list and its no-relic notice;
//   the seed readout, its copy control and the text confirmation of the copy
//   result;
//   the action row carrying the new-run control, which is the only action this
//   screen offers.
//
// WHAT IT DOES NOT OWN
//   the run: every action is reported into an injected sink, and nothing here
//   starts, ends, resumes or mutates a run;
//   the engine and the board, neither of which is reached;
//   ending the run, which has already happened by the time this state is
//   reached: `endRun` from the win state and `acknowledge` from the loss state
//   are the only edges into it;
//   the `hidden` attribute of `#screen-run-summary`, the focus trap, the focus
//   placement and the per-state announcement, all four of which
//   src/ui/screen-router.ts drives; `announcement()` supplies the words it
//   reads;
//   element-to-action binding for a bindable action, which
//   src/input/on-screen-controls.ts is the sole owner of.
//
// This module declares no colour, length, radius, duration or z-index and
// writes no inline style: style/_summary.scss carries the panel's measure,
// its leading, its stacking slot and its cadence, and style/_a11y.scss rings
// every `<button>` inside `.screen-layer`. `runSummaryLayout` republishes the
// measure, the leading and the rung this screen occupies, read from
// ../../theme/tokens, so the values a consumer or a suite asserts against
// come from the token layer rather than from a literal. It names no
// observability module — the report sink is injected — reads no storage,
// holds no timer, and performs no lookup and no DOM write at import time.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece. RUN SUMMARY is
// one area across the TypeScript and stylesheet halves, so these ordinals
// continue the sequence style/_summary.scss opened and are unique across both
// files. All are TARGET-ONLY: the pre-migration tree carried no run summary,
// no seed surface and no screen flow, so no construct of js/ is a source for
// any row below and the declared origin is requirement R8 with AAP 0.6.4 and
// working assumption A4.
//   TR-SUMMARY-08  target-only row  `createRunSummaryScreen()` and the `Screen`
//                                   lifecycle it implements
//   TR-SUMMARY-09  target-only row  the three readouts and their caption-then-
//                                   value order
//   TR-SUMMARY-10  target-only row  the pickup-ordered relic list and its
//                                   no-relic notice
//   TR-SUMMARY-11  target-only row  the verbatim seed readout, its copy control
//                                   and the text confirmation
//   TR-SUMMARY-12  target-only row  the action row and its injected sinks
//   TR-SUMMARY-13  target-only row  `runSummaryLayout`, the republished
//                                   measure, leading and stacking rung
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-SUMMARY-04  relic rows composed through the `summary` variant of
//                  `createRelicCard` rather than `createRelicTrayItem`
//   DL-SUMMARY-05  the copy ladder and the text confirmation of both outcomes
//   DL-SUMMARY-06  the order the stage goal is resolved in
//   DL-SUMMARY-07  initial focus marked on the copy control
//   DL-SUMMARY-08  the verdict carried by the panel heading, and an action
//                  control rendered only where a sink exists
//   DL-SUMMARY-09  the end-run control withdrawn from this screen
//   DL-SUMMARY-10  the `'copying'` state, `aria-busy`, one attempt at a time
//                  and the generation an answer is discarded against
//   DL-SUMMARY-11  focus placement and the entry announcement delegated to the
//                  router through the two switches and `announcement()`
//   DL-SUMMARY-12  `lastSummary()` outranking `summary()` on this screen
//   DL-SUMMARY-14  the error severity moved from the clipboard refusal to the
//                  failure of both copy tiers
//   DL-A11Y-06     the seed value's monospace treatment
//   DL-A11Y-07     the copy confirmation delivered as text

import type { StageConfig, StageGoal } from '../../config/stage-config';
import {
  DEFAULT_STAGE_CONFIG,
  stageGoalForIndex,
} from '../../config/stage-config';
import type { InputEmitter } from '../../input/input-manager';
import { findRelicById } from '../../relics/relic-registry';
import { RARITIES } from '../../relics/relic-types';
import type { ActiveRelic, Relic } from '../../relics/relic-types';
import type {
  PersistedRelic,
  RunOutcome,
  RunSummary,
} from '../../run/run-state';
import { fieldWidth, paragraphLineHeight, zIndex } from '../../theme/tokens';
import { focusInitial } from '../a11y/focus-manager';
import type { LiveRegionAnnouncer } from '../a11y/live-region';
import type { PreferenceStore, UiReporter } from '../a11y/settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from '../a11y/settings';
import type { RelicCard } from '../components/relic-card';
import { createRelicCard } from '../components/relic-card';
import type { RouterEventName, Screen, ScreenContext } from '../screen-router';

/** Label naming this module in every report. */
const REPORT_CONTEXT = 'run-summary';

/**
 * Selector the panel is mounted into, as index.html declares it and as
 * `SCREEN_MOUNTS.runSummary` of ../screen-router resolves it. Used only where
 * the router injected no host.
 */
export const RUN_SUMMARY_SELECTOR = '#screen-run-summary';

/** Logical name the host is reported under. */
const HOST_MOUNT = 'runSummary';

/**
 * The state this module renders, as ../screen-router and ../a11y/focus-manager
 * both name it.
 */
const SCREEN: Extract<ScreenContext['screen'], 'runSummary'> = 'runSummary';

/** The trigger the new-run action takes, as `TRANSITIONS.runSummary` names. */
const NEW_RUN_TRIGGER: RouterEventName = 'newRun';

/**
 * Every class this module applies. style/_summary.scss is the authority for
 * all of them and declares a rule for each; `visuallyHidden` is the shared
 * utility style/_a11y.scss declares.
 */
export const runSummaryClasses = Object.freeze({
  /** The panel itself, a `<section>`. */
  panel: 'run-summary',

  /** The panel's `<h2>`. index.html carries the page's only `<h1>`. */
  title: 'run-summary-title',

  /** The readout row. */
  scores: 'run-summary-scores',

  /** One readout. */
  score: 'run-summary-score',

  /** A readout's caption, which is its first child. */
  scoreLabel: 'run-summary-score-label',

  /** A readout's value, which is its second child. */
  scoreValue: 'run-summary-score-value',

  /** The caption above the relic list. */
  relicsTitle: 'run-summary-relics-title',

  /** The relic list, an `<ol>` whose source order IS pickup order. */
  relicList: 'run-summary-relic-list',

  /** The notice rendered beside an empty list. */
  relicsEmpty: 'run-summary-relics-empty',

  /** The seed group. */
  seed: 'run-summary-seed',

  /** The seed group's caption. */
  seedLabel: 'run-summary-seed-label',

  /** The seed itself, a selectable `<code>` that takes no tab stop. */
  seedValue: 'run-summary-seed-value',

  /** The copy control, a real `<button type="button">`. */
  seedCopy: 'run-summary-seed-copy',

  /** The text confirmation of the copy result. */
  seedStatus: 'run-summary-seed-status',

  /** The action row. */
  actions: 'run-summary-actions',

  /** One action control, a real `<button type="button">`. */
  action: 'run-summary-action',

  /** The visually-hidden utility of style/_a11y.scss. */
  visuallyHidden: 'visually-hidden',
});

/**
 * Every attribute this module writes.
 *
 * `focusInitial` is the marker ../a11y/focus-manager resolves a screen's
 * designated initial target by; `outcome` and `copyState` are read by neither
 * stylesheet and are written so the rendered state is inspectable from the DOM
 * by a suite and by the recorded-gameplay gate.
 */
export const runSummaryAttributes = Object.freeze({
  focusInitial: 'data-focus-initial',
  outcome: 'data-outcome',
  copyState: 'data-copy-state',
  action: 'data-action',
});

/** Attribute naming an element by reference. */
const LABELLED_BY_ATTRIBUTE = 'aria-labelledby';

/** Attribute pointing at an element's description. */
const DESCRIBED_BY_ATTRIBUTE = 'aria-describedby';

/**
 * Element identifier prefix in force where a caller supplies none. A second
 * concurrent instance passes an `idPrefix` of its own.
 */
export const DEFAULT_ID_PREFIX = 'run-summary';

/** Counter raised once per completed mount. */
const MOUNTED_METRIC = 'ui.runSummary.mounted';

/** Counter raised once per host the document did not supply. */
const MOUNT_MISSING_METRIC = 'ui.runSummary.mount_missing';

/** Counter raised where no document could create the tree. */
const NO_DOCUMENT_METRIC = 'ui.runSummary.no_document';

/** Counter raised once per render, carrying the relic count. */
const RENDERED_METRIC = 'ui.runSummary.rendered';

/** Counter raised once per entry to the state. */
const ENTERED_METRIC = 'ui.runSummary.entered';

/** Counter raised once per exit from the state. */
const LEFT_METRIC = 'ui.runSummary.left';

/** Counter raised per context whose screen is not this one. */
const FOREIGN_CONTEXT_METRIC = 'ui.runSummary.foreign_context';

/** Counter raised where no seed could be resolved. */
const SEED_MISSING_METRIC = 'ui.runSummary.seed_missing';

/** Counter raised per copy attempt, carrying the outcome and the path. */
const COPY_METRIC = 'ui.runSummary.seed_copy';

/**
 * ADDED: renders a caught value as one reportable string.
 *
 * The clipboard refusal is reported at `warn`, and `warn` carries no error
 * object, so the value's own message has to travel as a field or be lost — and
 * losing it is what makes a recovered failure undiagnosable. Total: it throws
 * for no input and answers for a value carrying no message at all.
 * DL-SUMMARY-14.
 */
const describeThrown = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error && value.message.length > 0) {
    return `${value.name}: ${value.message}`;
  }

  try {
    return String(value);
  } catch {
    return 'unreadable thrown value';
  }
};

/** Counter raised per relic identifier the catalogue does not carry. */
const RELIC_UNKNOWN_METRIC = 'ui.runSummary.relic_unknown';

/** Counter raised per stage goal that could not be resolved. */
const GOAL_UNRESOLVED_METRIC = 'ui.runSummary.goal_unresolved';

/** Counter raised per action activated, carrying the sink it reached. */
const ACTION_METRIC = 'ui.runSummary.action';

/** Counter raised per action offered with no sink to report into. */
const ACTION_WITHOUT_SINK_METRIC = 'ui.runSummary.action_without_sink';

/** Counter raised per injected port member that raised. */
const PORT_FAULT_METRIC = 'ui.runSummary.port_faulted';

/** Counter raised per call that reaches a destroyed screen. */
const AFTER_DESTROY_METRIC = 'ui.runSummary.after_destroy';

/** Counter raised once per `destroy`. */
const DESTROYED_METRIC = 'ui.runSummary.destroyed';

/**
 * The layout this screen occupies, republished from ../../theme/tokens so the
 * values a consumer or a suite asserts against are the token layer's own.
 *
 * Declarative only: style/_summary.scss applies all three, and no member of
 * this module writes a style. `layer` is the screen-overlay rung and `ceiling`
 * the modal rung above it, which this screen never reaches — the diagnostics
 * surface sits above both and must never be shadowed.
 */
export const runSummaryLayout = Object.freeze({
  /** `$field-width`: the panel's measure on the wide layout, in px. */
  measure: fieldWidth,

  /** The `p` leading of style/main.scss, as a ratio. */
  lineHeight: paragraphLineHeight,

  /** `$z-index-screen-overlay`. */
  layer: zIndex.screenOverlay,

  /** `$z-index-modal`: the rung this screen stays below. */
  ceiling: zIndex.modal,
});

/** The layout contract, as `runSummaryLayout` publishes it. */
export type RunSummaryLayout = typeof runSummaryLayout;

/** What the entry announcement is composed from. */
export interface RunSummaryAnnouncementInput {
  /** How the run ended, and `null` where it was not recorded. */
  readonly outcome: RunOutcome | null;
  readonly score: number;

  /** One-based stage number, as the readout shows it. */
  readonly stage: number;

  /** The goal readout's text, and an empty string where none resolved. */
  readonly goal: string;

  /** How many relics the run collected. */
  readonly relics: number;

  /** Whether a seed resolved and is therefore offered for copying. */
  readonly seedPresent: boolean;
}

/**
 * Every string this module renders. Overridable in whole or in part, so a
 * caller localises the panel without editing it.
 */
export const runSummaryCopy = Object.freeze({
  /**
   * The panel's heading, which carries the verdict. The dialog's own name is
   * declared at index.html.
   */
  title: (outcome: RunOutcome | null): string => {
    switch (outcome) {
      case 'won':
        return 'Run won';
      case 'lost':
        return 'Run lost';
      case 'abandoned':
        return 'Run ended';
      default:
        return 'Run summary';
    }
  },

  /** Names the readout row for a reader that cannot see it is a row. */
  scoresLabel: 'Run results',

  scoreLabel: 'Final score',
  stageLabel: 'Stage reached',
  goalLabel: 'Stage goal',

  /** Renders the final score. */
  scoreValue: (score: number): string => String(score),

  /** Renders the stage number a zero-based index names. */
  stageValue: (stageIndex: number): string => String(stageIndex + 1),

  /**
   * Renders a goal from its kind and target. Branches on the kind: a kind
   * other than `'score-threshold'` renders through the tile form.
   */
  goalValue: (kind: string, target: number): string =>
    kind === 'score-threshold'
      ? `${String(target)} score`
      : `Tile ${String(target)}`,

  /** Rendered where no goal could be resolved. */
  goalUnknown: 'Not recorded',

  /** The caption above the relic list. */
  relicsTitle: 'Relics collected',

  /** Names the relic list, and states the order it is in. */
  relicsLabel: 'Relics collected, in pickup order',

  /** Rendered beside an empty list. */
  relicsEmpty: 'No relics collected on this run.',

  /** Stands in for the name of an identifier the catalogue does not carry. */
  unknownRelicName: (id: string): string => id,

  /** Stands in for the description of such an identifier. */
  unknownRelicDescription: 'This relic is not in the catalogue.',

  /** The seed group's caption, which also names the group. */
  seedLabel: 'Run seed',

  /** Rendered where no seed resolved. */
  seedMissing: 'No seed recorded',

  /** The copy control's accessible name, carried as visible text. */
  copyLabel: 'Copy seed',

  /**
   * The confirmation before any copy is attempted, rendered from the first
   * paint. Decision DL-A11Y-07.
   */
  copyIdle: 'Select the seed to copy it, or use the copy button.',

  /** The confirmation after the clipboard accepted the seed. */
  copySucceeded: 'Seed copied.',

  /**
   * The confirmation after every path failed. The seed is left selected, which
   * is what the line instructs.
   */
  copyFailed:
    'Could not copy automatically. The seed is selected — copy it with ' +
    'your keyboard.',

  /** The confirmation where there is no seed to copy. */
  copyUnavailable: 'There is no seed to copy.',

  /** The confirmation while an attempt is in flight. DL-SUMMARY-10. */
  copying: 'Copying the seed…',

  newRunLabel: 'New run',

  /** The line announced on entering the state. */
  announcement: (input: RunSummaryAnnouncementInput): string => {
    const verdict =
      input.outcome === null ? 'Run over' : runSummaryCopy.title(input.outcome);
    const goal = input.goal.length === 0 ? '' : `, goal ${input.goal}`;
    const relics =
      input.relics === 1
        ? '1 relic collected'
        : `${String(input.relics)} relics collected`;
    const seed = input.seedPresent
      ? 'The run seed is on screen and can be copied.'
      : 'No run seed was recorded.';

    return (
      `${verdict}. Final score ${String(input.score)}. ` +
      `Stage ${String(input.stage)} reached${goal}. ${relics}. ${seed}`
    );
  },
});

/** The copy in force where a caller overrides none of it. */
export type RunSummaryCopy = typeof runSummaryCopy;

/**
 * The run this panel reads. Every member is optional, and one that is absent
 * or raises yields a neutral value and is counted, so the panel renders with
 * no run controller attached at all.
 *
 * `RunController` of ../../run/run-controller satisfies it as it stands.
 */
export interface RunSummaryRunPort {
  /** The finished run. Preferred over every other source. */
  summary?(): RunSummary | null;

  /**
   * The last finished run, where the run in force has already been cleared.
   */
  lastSummary?(): RunSummary | null;

  /** The run seed, verbatim. */
  seed?(): string;

  /** Zero-based index of the stage reached. */
  stageIndex?(): number;

  /** The goal of the stage in force. */
  stageGoal?(): StageGoal;

  /** The relics held, in pickup order. */
  relics?(): readonly PersistedRelic[];

}

/**
 * The relic registry this panel reads, for the live charge counts and the
 * declarations behind the identifiers a summary carries.
 *
 * `RelicRegistry` of ../../relics/relic-registry satisfies it as it stands,
 * and `active` returns the held relics already in pickup order.
 */
export interface RunSummaryRelicPort {
  active?(): readonly ActiveRelic[];
}

/**
 * The state machine the new-run action is reported into.
 *
 * `ScreenRouter` of ../screen-router satisfies it as it stands. The panel
 * sends the trigger and stops there: the router owns the edge and the run
 * controller owns the run.
 */
export interface RunSummaryRouterPort {
  send(trigger: RouterEventName): boolean;
}

/** The clipboard this panel writes the seed to. Nothing is ever READ back. */
export interface RunSummaryClipboardPort {
  writeText(text: string): Promise<void> | void;
}

/** Every construction parameter. All are optional. */
export interface RunSummaryScreenOptions {
  /**
   * Container the panel is appended to, already resolved. `null` marks a host
   * the caller looked for and did not find, which is reported.
   *
   * /screen-router resolves and injects it through `mount(host)`, so a lookup
   * here is only the fallback for a caller that mounts the panel itself.
   */
  readonly host?: Element | null;

  /**
   * Selector the host is resolved at where none is injected. Defaults to
   * `RUN_SUMMARY_SELECTOR`, which index.html declares.
   */
  readonly hostSelector?: string;

  /** Document the tree is created in. Defaults to a host's, then ambient. */
  readonly document?: Document | null;

  /** Sink every miss, refusal and degradation is reported through. */
  readonly reporter?: UiReporter;

  /**
   * Region the run's conclusion and each copy result are announced through.
   */
  readonly announcer?: LiveRegionAnnouncer | null;

  /** Store the effective reduced-motion value is read from. */
  readonly preferences?: PreferenceStore | null;

  /**
   * Whether focus is placed on entry. Defaults to `true`.
   *
   * SET FALSE WHERE A CALLER TRAPS THIS CONTAINER. A focus trap records the
   * element holding focus at the moment it engages so it can hand focus back on
   * release, and a caller that traps this container after this screen has placed
   * focus inside it records a target inside its own trap — one it cannot restore
   * to, and reports. The marked copy control is also the panel's first focusable
   * element, so a trap that places focus itself resolves to the same element and
   * the entrance is unchanged. Decisions DL-SUMMARY-07, DL-SUMMARY-11.
   */
  readonly placeFocus?: boolean;

  /**
   * Reduced-motion value that overrides the store and the context. `true`
   * withholds the smooth scroll the focus placement would otherwise request.
   */
  readonly reducedMotion?: boolean;

  /** The run the panel reads. */
  readonly run?: RunSummaryRunPort | null;

  /** The registry the relic rows are read from, where one is attached. */
  readonly relics?: RunSummaryRelicPort | null;

  /** The state machine the new-run action is reported into. */
  readonly router?: RunSummaryRouterPort | null;

  /**
   * The input emitter an action is published on, where no callback is
   * supplied. `InputManager` of ../../input/input-manager satisfies it.
   */
  readonly input?: Pick<InputEmitter, 'emit'> | null;

  /**
   * The progression curve a goal is derived from where the run port supplies
   * none. Defaults to `DEFAULT_STAGE_CONFIG`.
   */
  readonly stages?: StageConfig;

  /** The clipboard the seed is written to. Defaults to the platform's own. */
  readonly clipboard?: RunSummaryClipboardPort | null;

  /**
   * Called when the new-run control is activated. Takes precedence over the
   * router and the input emitter; where all three are absent the control is
   * not rendered.
   */
  readonly onNewRun?: () => void;


  /** Overrides for any subset of the copy. */
  readonly copy?: Partial<RunSummaryCopy>;

  /** Prefix of every element identifier. Defaults to `DEFAULT_ID_PREFIX`. */
  readonly idPrefix?: string;

  /**
   * Whether this screen announces the run's conclusion on entry. Defaults to
   * `true`. `false` is for a composition whose router reads the entry line,
   * which it takes from `announcement()` — the same words. The copy
   * confirmations are left on either way: they report an action, not an entry.
   * Decision DL-SUMMARY-11.
   */
  readonly announceEntry?: boolean;
}

/**
 * Which path a copy attempt took, and how it ended.
 *
 * `'copying'` is the IN-FLIGHT value: the clipboard write is asynchronous, so
 * an attempt occupies a state of its own between the press and the answer.
 * Decision DL-SUMMARY-10.
 */
export type RunSummaryCopyState =
  | 'idle'
  | 'copying'
  | 'copied'
  | 'failed'
  | 'unavailable';

/** One relic as the panel rendered it, in pickup order. */
export interface RunSummaryRelicRow {
  readonly id: string;

  /** One-based pickup slot: `pickupOrder + 1`, or the position plus one. */
  readonly slot: number;

  /** Charges remaining, and `undefined` on a relic with no budget. */
  readonly charges: number | undefined;

  /** Whether the identifier resolved to a catalogue declaration. */
  readonly known: boolean;
}

/** What the last render put on screen, as plain data. */
export interface RunSummarySnapshot {
  /** How the run ended, and `null` where it was not recorded. */
  readonly outcome: RunOutcome | null;
  readonly score: number;

  /** Zero-based index of the stage reached. */
  readonly stageIndex: number;

  /** The goal of that stage, and `null` where none resolved. */
  readonly goal: StageGoal | null;

  /** The goal readout's text, and an empty string where none resolved. */
  readonly goalText: string;

  /** The seed as rendered — verbatim — and `null` where none resolved. */
  readonly seed: string | null;

  /** The relics rendered, in pickup order. Never sorted and never reversed. */
  readonly relics: readonly RunSummaryRelicRow[];

  /** The copy confirmation in force. */
  readonly copyState: RunSummaryCopyState;

  /** Whether the new-run control was rendered. */
  readonly newRunOffered: boolean;
}

/** The mounted panel. Every member is safe to call at any time. */
export interface RunSummaryScreen extends Screen {
  /**
   * The panel this module created, and `null` where no document or host was
   * available to create it.
   */
  readonly element: HTMLElement | null;

  /**
   * Receives the container and builds the tree, once.
   *
   * Widened from `Screen.mount`, which the router always calls with a
   * resolved element: omitting the argument resolves the host from the
   * options instead — the injected element, and then `hostSelector` — and
   * `null` marks a host the caller looked for and did not find, which is
   * reported.
   *
   * @param host Container the panel is appended to.
   */
  mount(host?: Element | null): void;

  /** Whether `mount` resolved a host and built the tree. */
  isMounted(): boolean;

  /** What the last render put on screen, or `null` before the first. */
  readSnapshot(): RunSummarySnapshot | null;

  /** The measure, the leading and the stacking rung this panel occupies. */
  layout(): RunSummaryLayout;

  /**
   * Copies the seed on screen, through the clipboard and then through a
   * selection. Never rejects and never throws: every failure is reported,
   * confirmed as text and announced.
   *
   * @returns Whether the seed reached the clipboard.
   */
  copySeed(): Promise<boolean>;

  /**
   * Removes every node this module created, destroys every relic row and
   * detaches every listener. `unmount` is the lifecycle spelling of the same
   * call.
   */
  destroy(): void;
}

/** The relic list rendered where a run collected none. */
const EMPTY_ACTIVE_RELICS: readonly ActiveRelic[] = Object.freeze([]);

/** The relic list a summary carrying none yields. */
const EMPTY_PERSISTED_RELICS: readonly PersistedRelic[] = Object.freeze([]);

/** One relic as the panel is about to render it. */
interface RelicEntry {
  readonly id: string;

  /** The declaration the row is rendered from, real or stood in for. */
  readonly relic: Relic;

  /** Charges remaining, and `undefined` on a relic with no budget. */
  readonly charges: number | undefined;

  /** One-based pickup slot. */
  readonly slot: number;

  /** Whether `id` resolved to a catalogue declaration. */
  readonly known: boolean;
}

/** Everything one render reads, already resolved from its sources. */
interface ResolvedRun {
  readonly outcome: RunOutcome | null;
  readonly score: number;
  readonly stageIndex: number;
  readonly goal: StageGoal | null;
  readonly goalText: string;
  readonly seed: string | null;

  /** In pickup order, exactly as the source supplied it. */
  readonly relics: readonly RelicEntry[];
}

/** The members of a `runSummary` context this module reads. */
interface ContextInput {
  readonly summary: RunSummary | null;
  readonly outcome: RunOutcome | null;
  readonly seed: string | null;

  /** The value read at the moment of the transition, or `null` for none. */
  readonly reducedMotion: boolean | null;
}

/** The context in force before a first entry, and after a foreign one. */
const NO_CONTEXT: ContextInput = Object.freeze({
  summary: null,
  outcome: null,
  seed: null,
  reducedMotion: null,
});

/**
 * Reads the ambient document.
 *
 * @returns The document, or `null` outside a browser.
 */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Merges a caller's overrides onto the default copy.
 *
 * @param overrides Subset to replace, or `undefined` for none.
 * @returns The copy in force, frozen.
 */
function resolveCopy(
  overrides: Partial<RunSummaryCopy> | undefined,
): RunSummaryCopy {
  return overrides === undefined
    ? runSummaryCopy
    : Object.freeze({ ...runSummaryCopy, ...overrides });
}

/**
 * Reads a value as a finite non-negative integer count.
 *
 * @param value Value to read.
 * @returns The count, or `undefined` for anything else.
 */
function toCount(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : undefined;
}

/**
 * Reads a value as a finite score, which may be any non-negative number.
 *
 * @param value Value to read.
 * @returns The score, or `undefined` for anything else.
 */
function toScore(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Reads a value as a non-empty string.
 *
 * @param value Value to read.
 * @returns The string, or `null` for anything else and for the empty string.
 */
function toText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Views a value as a property bag, so a member of an injected record is read
 * without assuming the record has the declared shape.
 *
 * @param value Value to view.
 * @returns The value as a bag, or an empty bag where it carries no members.
 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Reads a relic declaration from an injected record, judged on stored data.
 *
 * @param value Value to read.
 * @returns The declaration, or `null` where the value is not one.
 */
function toRelicDeclaration(value: unknown): Relic | null {
  const record = asRecord(value);

  return typeof record['id'] === 'string' &&
    typeof record['name'] === 'string' &&
    typeof record['rarity'] === 'string'
    ? (value as Relic)
    : null;
}

/**
 * Builds the run-summary panel.
 *
 * @param options The collaborators and the copy.
 * @returns The mounted screen, implementing `Screen` of ../screen-router.
 * @example
 * ```ts
 * // The router resolves the container and hands it to `mount`.
 * const screen = createRunSummaryScreen({
 *   run,
 *   relics: registry,
 *   router,
 *   announcer,
 *   preferences,
 *   reporter,
 * });
 *
 * const router = createScreenRouter({ screens: { runSummary: screen } });
 * ```
 */
export function createRunSummaryScreen(
  options: RunSummaryScreenOptions = {},
): RunSummaryScreen {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const copy = resolveCopy(options.copy);
  const idPrefix = options.idPrefix ?? DEFAULT_ID_PREFIX;
  const hostSelector = options.hostSelector ?? RUN_SUMMARY_SELECTOR;
  const stages = options.stages ?? DEFAULT_STAGE_CONFIG;
  const runPort = options.run ?? null;
  const relicPort = options.relics ?? null;
  const routerPort = options.router ?? null;
  const inputPort = options.input ?? null;
  const announcer = options.announcer ?? null;
  const preferences = options.preferences ?? null;
  const placeFocusOnEntry = options.placeFocus !== false;
  const onNewRun = options.onNewRun;
  const announceOnEntry = options.announceEntry !== false;

  /**
   * Whether the new-run action has an effective sink. A control with none is
   * not rendered. Decision DL-SUMMARY-08.
   *
   * New run is the only action this screen renders. Decision DL-SUMMARY-09.
   */
  const newRunOffered =
    onNewRun !== undefined || routerPort !== null || inputPort !== null;

  /** Element identifiers, derived from the prefix once. */
  const ids = Object.freeze({
    title: `${idPrefix}-title`,
    relicsTitle: `${idPrefix}-relics-title`,
    seedLabel: `${idPrefix}-seed-label`,
    seedValue: `${idPrefix}-seed-value`,
    seedStatus: `${idPrefix}-seed-status`,
  });

  /** Listener removals, drained by `destroy`. */
  const teardown: (() => void)[] = [];

  /** The relic rows on screen, in the order they were created. */
  const rows: RelicCard[] = [];

  let owner: Document | null = null;
  let host: Element | null = null;
  let panel: HTMLElement | null = null;
  let titleElement: HTMLElement | null = null;
  let scoreValue: HTMLElement | null = null;
  let stageValue: HTMLElement | null = null;
  let goalValue: HTMLElement | null = null;
  let relicList: HTMLElement | null = null;
  let relicsEmpty: HTMLElement | null = null;
  let seedValue: HTMLElement | null = null;
  let seedStatus: HTMLElement | null = null;
  let copyButton: HTMLButtonElement | null = null;

  let context: ContextInput = NO_CONTEXT;
  let snapshot: RunSummarySnapshot | null = null;
  let renderedSeed: string | null = null;
  let copyState: RunSummaryCopyState = 'idle';

  /** Whether a copy attempt is in flight. DL-SUMMARY-10. */
  let copyInFlight = false;

  /**
   * The lifecycle generation a copy attempt belongs to.
   *
   * Raised by `leave`, by `destroy` and by a render that replaces the seed, so
   * an attempt cannot write state or announce over what came after it.
   * DL-SUMMARY-10.
   */
  let copyGeneration = 0;
  let announced = false;
  let mountAttempted = false;
  let destroyed = false;

  /**
   * Calls one optional port member, contained.
   *
   * @param member Member name carried into the report.
   * @param call The bound member, or `undefined` where the port omits it.
   * @param fallback Value returned where the member is absent or raises.
   * @returns The member's value, or `fallback`.
   */
  const callPort = <T>(
    member: string,
    call: (() => T) | undefined,
    fallback: T,
  ): T => {
    if (call === undefined) {
      return fallback;
    }

    try {
      return call();
    } catch (error) {
      reporter.error('a run summary port member raised', error, {
        context: REPORT_CONTEXT,
        member,
      });
      reporter.count(PORT_FAULT_METRIC, { context: REPORT_CONTEXT, member });

      return fallback;
    }
  };

  /**
   * Announces one line through the injected region, contained. An absent
   * region skips the announcement; nothing is written to a console in its
   * place.
   *
   * @param text Line to announce.
   */
  const announce = (text: string): void => {
    if (announcer === null || text.length === 0) {
      return;
    }

    try {
      announcer.announceText(text);
    } catch (error) {
      reporter.error('a run summary announcement raised', error, {
        context: REPORT_CONTEXT,
      });
    }
  };

  /**
   * The effective reduced-motion value: the explicit override, then the store,
   * then the value the transition carried, and `false` where none is
   * available.
   *
   * @returns Whether motion is to be reduced.
   */
  const readReducedMotion = (): boolean => {
    if (typeof options.reducedMotion === 'boolean') {
      return options.reducedMotion;
    }

    if (preferences !== null) {
      return callPort<boolean>(
        'isReducedMotion',
        preferences.isReducedMotion.bind(preferences),
        false,
      );
    }

    return context.reducedMotion ?? false;
  };

  /**
   * The FINISHED run: the context's summary first, then the last run the port
   * recorded, and the run in force only as the fallback.
   *
   * The port's `lastSummary()` outranks its `summary()`: this screen is reached
   * after a run ended, ending one opens its replacement, and `summary()` there
   * describes the run that has not been played yet. Decision DL-SUMMARY-12.
   *
   * @returns The summary, or `null` where no source supplied one.
   */
  const resolveSummary = (): RunSummary | null => {
    if (context.summary !== null) {
      return context.summary;
    }

    if (runPort === null) {
      return null;
    }

    const finished = callPort<RunSummary | null>(
      'lastSummary',
      runPort.lastSummary?.bind(runPort),
      null,
    );

    if (finished !== null) {
      return finished;
    }

    return callPort<RunSummary | null>(
      'summary',
      runPort.summary?.bind(runPort),
      null,
    );
  };

  /**
   * The zero-based stage index reached: the summary's first, then the port's.
   *
   * @param summary The summary in force, or `null`.
   * @returns The index, and `0` where no source supplied one.
   */
  const resolveStageIndex = (summary: RunSummary | null): number => {
    const fromSummary = toCount(summary?.stageIndex);

    if (fromSummary !== undefined) {
      return fromSummary;
    }

    if (runPort === null) {
      return 0;
    }

    return (
      toCount(
        callPort<number | null>(
          'stageIndex',
          runPort.stageIndex?.bind(runPort),
          null,
        ),
      ) ?? 0
    );
  };

  /**
   * The goal of the stage reached.
   *
   * @param stageIndex Index the readout is showing.
   * @returns The goal, or `null` where neither path resolved one.
   */
  const resolveGoal = (stageIndex: number): StageGoal | null => {
    if (runPort !== null && runPort.stageGoal !== undefined) {
      const portIndex = callPort<number | null>(
        'stageIndex',
        runPort.stageIndex?.bind(runPort),
        null,
      );

      if (portIndex === null || portIndex === stageIndex) {
        const goal = callPort<StageGoal | null>(
          'stageGoal',
          runPort.stageGoal.bind(runPort),
          null,
        );

        if (goal !== null) {
          return goal;
        }
      }
    }

    try {
      return stageGoalForIndex(stageIndex, stages);
    } catch (error) {
      reporter.error('the stage goal could not be derived', error, {
        context: REPORT_CONTEXT,
        stageIndex,
      });
      reporter.count(GOAL_UNRESOLVED_METRIC, {
        context: REPORT_CONTEXT,
        stageIndex,
      });

      return null;
    }
  };

  /**
   * The run seed, VERBATIM: the summary's first, then the context's, then the
   * port's. No source is re-normalised, re-hashed, trimmed or truncated.
   *
   * @param summary The summary in force, or `null`.
   * @returns The seed, or `null` where no source supplied a non-empty one.
   */
  const resolveSeed = (summary: RunSummary | null): string | null => {
    const fromSummary = toText(summary?.seed);

    if (fromSummary !== null) {
      return fromSummary;
    }

    const fromContext = toText(context.seed);

    if (fromContext !== null) {
      return fromContext;
    }

    if (runPort === null) {
      return null;
    }

    return toText(
      callPort<string | null>('seed', runPort.seed?.bind(runPort), null),
    );
  };

  /**
   * Stands in for a declaration the catalogue does not carry. The row is
   * rendered from it, carrying the identifier as the name.
   *
   * @param id Identifier to stand in for.
   * @returns A declaration carrying that identifier.
   */
  const standInRelic = (id: string): Relic =>
    Object.freeze({
      id,
      name: copy.unknownRelicName(id),
      rarity: RARITIES[0],
      description: copy.unknownRelicDescription,
      hooks: Object.freeze({}),
    });

  /**
   * Reads one held relic as a row. Its slot is the `pickupOrder` the registry
   * assigned and its count the budget the registry holds; neither is
   * recomputed here.
   *
   * @param held Held relic, as `RelicRegistry.active` returns it.
   * @param index Position in the list supplied, used where no slot is
   *   carried.
   * @returns The row.
   */
  const readHeldEntry = (held: ActiveRelic, index: number): RelicEntry => {
    const record = asRecord(held);
    const declaration = toRelicDeclaration(record['definition']);
    const id = declaration?.id ?? '';
    const order = toCount(record['pickupOrder']);

    if (declaration === null) {
      reporter.count(RELIC_UNKNOWN_METRIC, {
        context: REPORT_CONTEXT,
        source: 'registry',
      });
    }

    return {
      id,
      relic: declaration ?? standInRelic(id),
      charges: toCount(record['charges']),
      slot: order === undefined ? index + 1 : order + 1,
      known: declaration !== null,
    };
  };

  /**
   * Reads one persisted relic as a row. The array position IS the pickup
   * order, which the run-state envelope guarantees, so the slot is that
   * position.
   *
   * @param relic Persisted relic, as the summary carries it.
   * @param index Position in the summary's own array.
   * @returns The row.
   */
  const readPersistedEntry = (
    relic: PersistedRelic,
    index: number,
  ): RelicEntry => {
    const id = toText(relic.id) ?? '';
    const declaration = id.length === 0 ? undefined : findRelicById(id);

    if (declaration === undefined) {
      reporter.count(RELIC_UNKNOWN_METRIC, {
        context: REPORT_CONTEXT,
        source: 'summary',
        relicId: id,
      });
    }

    return {
      id,
      relic: declaration ?? standInRelic(id),
      charges: toCount(relic.charges),
      slot: index + 1,
      known: declaration !== undefined,
    };
  };

  /**
   * The relics collected, in pickup order.
   *
   * @param summary The summary in force, or `null`.
   * @returns The rows, in pickup order.
   */
  const resolveRelics = (
    summary: RunSummary | null,
  ): readonly RelicEntry[] => {
    if (relicPort !== null && relicPort.active !== undefined) {
      const held = callPort<readonly ActiveRelic[]>(
        'active',
        relicPort.active.bind(relicPort),
        EMPTY_ACTIVE_RELICS,
      );

      if (held.length > 0) {
        return held.map(readHeldEntry);
      }
    }

    const persisted = summary?.relics ?? EMPTY_PERSISTED_RELICS;

    return persisted.map(readPersistedEntry);
  };

  /**
   * Everything one render reads, resolved from the context and the ports.
   *
   * @returns The resolved run.
   */
  const resolveRun = (): ResolvedRun => {
    const summary = resolveSummary();
    const stageIndex = resolveStageIndex(summary);
    const goal = resolveGoal(stageIndex);

    return {
      outcome: context.outcome,
      score: toScore(summary?.score) ?? 0,
      stageIndex,
      goal,
      goalText:
        goal === null
          ? copy.goalUnknown
          : copy.goalValue(goal.kind, goal.target),
      seed: resolveSeed(summary),
      relics: resolveRelics(summary),
    };
  };

  /**
   * Creates one element, with its class and optionally its text.
   *
   * @param doc Document the element is created in.
   * @param tag Tag to create.
   * @param className Class to apply.
   * @param text Text content, where the element carries any.
   * @returns The element.
   */
  const make = <K extends keyof HTMLElementTagNameMap>(
    doc: Document,
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const element = doc.createElement(tag);

    element.className = className;

    if (text !== undefined) {
      element.textContent = text;
    }

    return element;
  };

  /**
   * Creates one readout: its caption element first and its value element
   * second, which is the order style/_summary.scss reads them in.
   *
   * @param doc Document the readout is created in.
   * @param label Caption text.
   * @returns The readout and the value element inside it.
   */
  const makeReadout = (
    doc: Document,
    label: string,
  ): { readonly readout: HTMLElement; readonly value: HTMLElement } => {
    const readout = make(doc, 'div', runSummaryClasses.score);
    const value = make(doc, 'span', runSummaryClasses.scoreValue);

    readout.append(
      make(doc, 'span', runSummaryClasses.scoreLabel, label),
      value,
    );

    return { readout, value };
  };

  /**
   * Registers a listener and queues its removal.
   *
   * @param target Target the listener is bound to.
   * @param type Event type.
   * @param handler Listener to register.
   */
  const listen = (
    target: EventTarget,
    type: string,
    handler: EventListener,
  ): void => {
    target.addEventListener(type, handler);
    teardown.push((): void => {
      target.removeEventListener(type, handler);
    });
  };

  /**
   * Creates one control as a real `<button type="button">`, which Tab reaches
   * and Enter and Space both activate with no role, no `tabindex` and no rule
   * of its own. Never an anchor, and never a `div`.
   *
   * @param doc Document the control is created in.
   * @param className Class the control carries.
   * @param label Accessible name, carried as visible text.
   * @param action Value written to the action attribute.
   * @param activate Called on every activation, contained by the caller.
   * @returns The control.
   */
  const makeButton = (
    doc: Document,
    className: string,
    label: string,
    action: string,
    activate: EventListener,
  ): HTMLButtonElement => {
    const button = make(doc, 'button', className, label);

    button.type = 'button';
    button.setAttribute(runSummaryAttributes.action, action);
    listen(button, 'click', activate);

    return button;
  };

  /**
   * Publishes the new-run action.
   *
   * Precedence: the caller's own callback, then the router's `newRun` edge —
   * which is the edge AAP Figure 6 declares out of this state — and then the
   * input emitter's `startRun`. The panel starts no run itself.
   */
  const publishNewRun = (): void => {
    try {
      if (onNewRun !== undefined) {
        onNewRun();
        reporter.count(ACTION_METRIC, {
          context: REPORT_CONTEXT,
          action: 'newRun',
          sink: 'callback',
        });

        return;
      }

      if (routerPort !== null) {
        routerPort.send(NEW_RUN_TRIGGER);
        reporter.count(ACTION_METRIC, {
          context: REPORT_CONTEXT,
          action: 'newRun',
          sink: 'router',
        });

        return;
      }

      if (inputPort !== null) {
        inputPort.emit('startRun', undefined);
        reporter.count(ACTION_METRIC, {
          context: REPORT_CONTEXT,
          action: 'newRun',
          sink: 'input',
        });

        return;
      }

      reporter.count(ACTION_WITHOUT_SINK_METRIC, {
        context: REPORT_CONTEXT,
        action: 'newRun',
      });
    } catch (error) {
      reporter.error('the new-run action raised', error, {
        context: REPORT_CONTEXT,
        action: 'newRun',
      });
    }
  };

  /* ----------------------------------------------------------------------
   * The copy ladder
   * ------------------------------------------------------------------- */

  /**
   * Writes the copy confirmation as TEXT and reflects it on the attribute. No
   * colour change and no icon stands in for it.
   *
   * @param next State the confirmation is in.
   */
  const setCopyState = (next: RunSummaryCopyState): void => {
    copyState = next;

    if (panel !== null) {
      panel.setAttribute(runSummaryAttributes.copyState, next);
    }

    if (seedStatus === null) {
      return;
    }

    // `aria-busy` while an attempt is in flight, so assistive technology is
    // told the region is mid-change rather than reading a confirmation that has
    // not arrived. DL-SUMMARY-10.
    if (next === 'copying') {
      seedStatus.setAttribute('aria-busy', 'true');
    } else {
      seedStatus.removeAttribute('aria-busy');
    }

    switch (next) {
      case 'copying':
        seedStatus.textContent = copy.copying;

        return;
      case 'copied':
        seedStatus.textContent = copy.copySucceeded;

        return;
      case 'failed':
        seedStatus.textContent = copy.copyFailed;

        return;
      case 'unavailable':
        seedStatus.textContent = copy.copyUnavailable;

        return;
      default:
        seedStatus.textContent = copy.copyIdle;

        return;
    }
  };

  /**
   * Marks the copy control busy while an attempt is in flight, where a control
   * was built.
   *
   * `aria-disabled`, NOT `disabled`: disabling the control the player just
   * activated takes it out of the tab order, and the browser drops focus to the
   * body when that happens — so a keyboard user loses their place for the
   * length of a clipboard write. The re-entry guard is `copyInFlight`, which
   * refuses the second press regardless of what the attribute says.
   * DL-SUMMARY-10.
   *
   * @param busy Whether an attempt is in flight.
   */
  const setCopyControlBusy = (busy: boolean): void => {
    if (copyButton === null) {
      return;
    }

    if (busy) {
      copyButton.setAttribute('aria-disabled', 'true');

      return;
    }

    copyButton.removeAttribute('aria-disabled');
  };

  /**
   * The clipboard in force: the injected port where one was supplied — `null`
   * opts out — and otherwise the platform's own, where it exists and carries
   * a writer. Nothing is ever read back from it.
   *
   * @returns The port, or `null` where none is available.
   */
  const readClipboard = (): RunSummaryClipboardPort | null => {
    if (options.clipboard !== undefined) {
      return options.clipboard;
    }

    if (typeof navigator === 'undefined') {
      return null;
    }

    const platform: unknown = navigator.clipboard;

    return typeof asRecord(platform)['writeText'] === 'function'
      ? (platform as RunSummaryClipboardPort)
      : null;
  };

  /**
   * Selects the seed's text, which is the keyboard copy's path. The readout is
   * selectable regardless — style/_summary.scss reverses the suppression the
   * board carries — and this only places the selection for the player.
   *
   * @returns Whether the selection was placed.
   */
  const selectSeedText = (): boolean => {
    if (owner === null || seedValue === null) {
      return false;
    }

    try {
      const read = owner.getSelection;

      if (typeof read !== 'function') {
        return false;
      }

      const selection = read.call(owner);

      if (selection === null) {
        return false;
      }

      const range = owner.createRange();

      range.selectNodeContents(seedValue);
      selection.removeAllRanges();
      selection.addRange(range);

      return true;
    } catch (error) {
      reporter.error('the seed text could not be selected', error, {
        context: REPORT_CONTEXT,
      });

      return false;
    }
  };

  /**
   * Asks the document to copy the current selection. The non-clipboard path,
   * which is what an insecure origin and a refused permission fall back to.
   *
   * @returns Whether the document reported the copy as performed.
   */
  const copySelection = (): boolean => {
    if (owner === null) {
      return false;
    }

    try {
      const exec = owner.execCommand;

      return typeof exec === 'function' && exec.call(owner, 'copy') === true;
    } catch (error) {
      reporter.error('the selection copy raised', error, {
        context: REPORT_CONTEXT,
      });

      return false;
    }
  };

  /**
   * Copies the seed on screen. Never rejects, never throws, and never reads
   * the clipboard, rewrites the address bar or issues a request.
   *
   * @returns Whether the seed reached the clipboard.
   */
  const copySeed = async (): Promise<boolean> => {
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, {
        context: REPORT_CONTEXT,
        member: 'copySeed',
      });

      return false;
    }

    const seed = renderedSeed;

    if (seed === null) {
      setCopyState('unavailable');
      announce(copy.copyUnavailable);
      reporter.count(COPY_METRIC, {
        context: REPORT_CONTEXT,
        outcome: 'unavailable',
        path: 'none',
      });

      return false;
    }

    // SERIALISED. One attempt is in flight at a time: a second press while the
    // clipboard has not answered is counted and refused rather than racing the
    // first, so two answers cannot arrive for one visible state.
    // DL-SUMMARY-10.
    if (copyInFlight) {
      reporter.count(COPY_METRIC, {
        context: REPORT_CONTEXT,
        outcome: 'refused',
        path: 'in-flight',
      });

      return false;
    }

    // THE LIFECYCLE TOKEN. `leave`, `unmount` and every re-render raise the
    // generation, so an answer that arrives for a visit already left writes
    // nothing and announces nothing. DL-SUMMARY-10.
    const generation = copyGeneration;
    const stale = (): boolean => destroyed || generation !== copyGeneration;

    copyInFlight = true;
    setCopyState('copying');
    setCopyControlBusy(true);

    try {
      const clipboard = readClipboard();

      if (clipboard !== null) {
        try {
          await clipboard.writeText(seed);

          if (stale()) {
            reporter.count(COPY_METRIC, {
              context: REPORT_CONTEXT,
              outcome: 'stale',
              path: 'clipboard',
            });

            return false;
          }

          setCopyState('copied');
          announce(copy.copySucceeded);
          reporter.count(COPY_METRIC, {
            context: REPORT_CONTEXT,
            outcome: 'copied',
            path: 'clipboard',
          });

          return true;
        } catch (error) {
          // The refusal is reported and the selection path below is taken.
          // Decision DL-SUMMARY-05.
          //
          // CHANGED: reported at `warn`, where it used to be reported at
          // `error`. A clipboard refusal is the ORDINARY outcome outside a
          // secure context or without the permission, and it is recovered from
          // by the selection path immediately below — so an error severity
          // claimed a failure the feature had already survived. The error's own
          // message is carried in a field, because `warn` takes no error object;
          // the tier-2 failure below is where the error severity now belongs.
          // DL-SUMMARY-14.
          reporter.log('warn', 'the clipboard refused the seed', {
            context: REPORT_CONTEXT,
            reason: describeThrown(error),
          });

          if (stale()) {
            reporter.count(COPY_METRIC, {
              context: REPORT_CONTEXT,
              outcome: 'stale',
              path: 'clipboard',
            });

            return false;
          }
        }
      }

      const selected = selectSeedText();

      if (selected && copySelection()) {
        setCopyState('copied');
        announce(copy.copySucceeded);
        reporter.count(COPY_METRIC, {
          context: REPORT_CONTEXT,
          outcome: 'copied',
          path: 'selection',
        });

        return true;
      }

      // The selection is left in place, which is what the confirmation below
      // instructs. Decision DL-SUMMARY-05.
      setCopyState('failed');
      announce(copy.copyFailed);

      // ADDED: the error severity, moved here from the clipboard refusal above.
      // BOTH tiers have now failed, so the seed genuinely did not reach the
      // player — which is the outcome that warrants it. DL-SUMMARY-14.
      reporter.log(
        'error',
        'the seed reached neither the clipboard nor a selection',
        {
          context: REPORT_CONTEXT,
          selected,
        },
      );
      reporter.count(COPY_METRIC, {
        context: REPORT_CONTEXT,
        outcome: 'failed',
        path: selected ? 'selection' : 'none',
      });

      return false;
    } finally {
      copyInFlight = false;

      // The busy mark comes off only for the visit that made the attempt.
      if (!stale()) {
        setCopyControlBusy(false);
      }
    }
  };

  /** Activates the copy control. Reports every failure, and throws never. */
  const onCopyActivate = (): void => {
    try {
      void copySeed().catch((error: unknown): void => {
        reporter.error('the seed copy path raised', error, {
          context: REPORT_CONTEXT,
        });
      });
    } catch (error) {
      reporter.error('the seed copy control raised', error, {
        context: REPORT_CONTEXT,
      });
    }
  };

  /**
   * Builds the panel and caches every reference, so no member below performs a
   * lookup of its own. index.html declares `#screen-run-summary` empty, and
   * the order below is the source order style/_summary.scss reads.
   *
   * @param target Host the panel is appended to.
   * @param doc Document the tree is created in.
   */
  const build = (target: Element, doc: Document): void => {
    const created = make(doc, 'section', runSummaryClasses.panel);
    const heading = make(doc, 'h2', runSummaryClasses.title, copy.title(null));

    heading.id = ids.title;

    const scores = make(doc, 'div', runSummaryClasses.scores);

    scores.setAttribute('role', 'group');
    scores.setAttribute('aria-label', copy.scoresLabel);

    const score = makeReadout(doc, copy.scoreLabel);
    const stage = makeReadout(doc, copy.stageLabel);
    const goal = makeReadout(doc, copy.goalLabel);

    scores.append(score.readout, stage.readout, goal.readout);

    const relicsHeading = make(
      doc,
      'h3',
      runSummaryClasses.relicsTitle,
      copy.relicsTitle,
    );

    relicsHeading.id = ids.relicsTitle;

    const list = make(doc, 'ol', runSummaryClasses.relicList);

    // Declared as well as implied: the ordered list keeps its `listitem`
    // children, and its accessible name states the order it is in.
    list.setAttribute('role', 'list');
    list.setAttribute(LABELLED_BY_ATTRIBUTE, ids.relicsTitle);
    list.setAttribute('aria-label', copy.relicsLabel);

    const notice = make(
      doc,
      'p',
      runSummaryClasses.relicsEmpty,
      copy.relicsEmpty,
    );

    notice.hidden = true;

    const seedGroup = make(doc, 'div', runSummaryClasses.seed);

    seedGroup.setAttribute('role', 'group');
    seedGroup.setAttribute(LABELLED_BY_ATTRIBUTE, ids.seedLabel);

    const seedCaption = make(
      doc,
      'span',
      runSummaryClasses.seedLabel,
      copy.seedLabel,
    );

    seedCaption.id = ids.seedLabel;

    // A `<code>`: selectable text that takes no tab stop of its own. The copy
    // control beside it is the keyboard path to the seed.
    const value = make(
      doc,
      'code',
      runSummaryClasses.seedValue,
      copy.seedMissing,
    );

    value.id = ids.seedValue;

    const status = make(
      doc,
      'p',
      runSummaryClasses.seedStatus,
      copy.copyIdle,
    );

    status.id = ids.seedStatus;

    const control = makeButton(
      doc,
      runSummaryClasses.seedCopy,
      copy.copyLabel,
      'copySeed',
      onCopyActivate,
    );

    control.setAttribute(
      DESCRIBED_BY_ATTRIBUTE,
      `${ids.seedValue} ${ids.seedStatus}`,
    );

    // The designated initial target ../a11y/focus-manager resolves by marker.
    control.setAttribute(runSummaryAttributes.focusInitial, '');

    seedGroup.append(seedCaption, value, control, status);
    created.append(heading, scores, relicsHeading, list, notice, seedGroup);

    if (newRunOffered) {
      const actions = make(doc, 'div', runSummaryClasses.actions);

      actions.append(
        makeButton(
          doc,
          runSummaryClasses.action,
          copy.newRunLabel,
          'newRun',
          publishNewRun,
        ),
      );

      created.append(actions);
    }

    target.append(created);

    panel = created;
    titleElement = heading;
    scoreValue = score.value;
    stageValue = stage.value;
    goalValue = goal.value;
    relicList = list;
    relicsEmpty = notice;
    seedValue = value;
    seedStatus = status;
    copyButton = control;

    setCopyState('idle');
  };

  /**
   * Resolves the host and builds the tree, once. Every miss is reported and
   * leaves a screen whose members are safe no-ops.
   *
   * @param target Host ../screen-router injected, where it called `mount`.
   */
  const mount = (target?: Element | null): void => {
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, {
        context: REPORT_CONTEXT,
        member: 'mount',
      });

      return;
    }

    if (panel !== null) {
      return;
    }

    mountAttempted = true;

    const injected = target === undefined ? options.host : target;
    const doc =
      options.document ??
      injected?.ownerDocument ??
      readAmbientDocument();

    if (doc === null) {
      reporter.log('warn', 'the run summary has no document to render into', {
        context: REPORT_CONTEXT,
      });
      reporter.count(NO_DOCUMENT_METRIC, { context: REPORT_CONTEXT });

      return;
    }

    owner = doc;

    if (injected === null) {
      reporter.log('warn', 'the run summary host was supplied as absent', {
        context: REPORT_CONTEXT,
        mount: HOST_MOUNT,
        selector: hostSelector,
      });
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        mount: HOST_MOUNT,
        cause: 'supplied-null',
      });

      return;
    }

    const resolved =
      injected ??
      resolveMount<HTMLElement>(hostSelector, {
        root: doc,
        reporter,
        context: REPORT_CONTEXT,
        name: HOST_MOUNT,
      });

    if (resolved === null) {
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        mount: HOST_MOUNT,
        selector: hostSelector,
        cause: 'no-match',
      });

      return;
    }

    host = resolved;
    build(resolved, doc);
    reporter.count(MOUNTED_METRIC, {
      context: REPORT_CONTEXT,
      measure: runSummaryLayout.measure,
      lineHeight: runSummaryLayout.lineHeight,
      layer: runSummaryLayout.layer,
      ceiling: runSummaryLayout.ceiling,
      newRun: newRunOffered,
    });
  };

  /** Mounts from the options where the lifecycle has not mounted already. */
  const ensureMounted = (): void => {
    if (panel === null && !mountAttempted && !destroyed) {
      mount();
    }
  };

  /**
   * Writes one element's text, reporting an outlet the tree does not carry.
   *
   * @param element Outlet to write, or `null` where it did not resolve.
   * @param mountName Logical name carried into the report.
   * @param text Text to write.
   */
  const writeText = (
    element: HTMLElement | null,
    mountName: string,
    text: string,
  ): void => {
    if (element === null) {
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        mount: mountName,
        cause: 'not-built',
      });

      return;
    }

    element.textContent = text;
  };

  /**
   * Destroys every relic row and empties the list, so a re-render duplicates
   * nothing.
   */
  const clearRelics = (): void => {
    for (const row of rows) {
      try {
        row.destroy();
      } catch (error) {
        reporter.error('a run summary relic row could not be released', error, {
          context: REPORT_CONTEXT,
        });
      }
    }

    rows.length = 0;

    if (relicList !== null) {
      relicList.replaceChildren();
    }
  };

  /**
   * Renders the relics collected, in pickup order.
   *
   * @param entries Rows to render, in pickup order.
   */
  const renderRelics = (entries: readonly RelicEntry[]): void => {
    clearRelics();

    if (relicList === null) {
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        mount: 'relicList',
        cause: 'not-built',
      });
    } else {
      const reducedMotion = readReducedMotion();

      for (const entry of entries) {
        rows.push(
          createRelicCard({
            relic: entry.relic,
            variant: 'summary',
            charges: entry.charges,
            slot: entry.slot,
            host: relicList,
            document: owner,
            reporter,
            preferences,
            reducedMotion,
          }),
        );
      }
    }

    if (relicsEmpty === null) {
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        mount: 'relicsEmpty',
        cause: 'not-built',
      });

      return;
    }

    relicsEmpty.hidden = entries.length > 0;
  };

  /**
   * Renders the seed VERBATIM and reconciles the copy confirmation.
   *
   * The string written is the string the source supplied, character for
   * character: nothing is trimmed, cased, hashed, truncated or ellipsised. A
   * refresh carrying the same seed keeps the confirmation already on screen,
   * so an in-state update neither repeats nor discards it.
   *
   * @param seed Seed to render, or `null` where none resolved.
   */
  const renderSeed = (seed: string | null): void => {
    const changed = seed !== renderedSeed;

    if (changed) {
      // A copy of the seed being replaced no longer describes what is on
      // screen, so its answer writes nothing. DL-SUMMARY-10.
      copyGeneration += 1;
    }

    renderedSeed = seed;
    writeText(seedValue, 'seedValue', seed ?? copy.seedMissing);

    if (copyButton !== null) {
      copyButton.disabled = seed === null;
    }

    if (seed === null) {
      reporter.count(SEED_MISSING_METRIC, { context: REPORT_CONTEXT });

      if (copyState !== 'unavailable') {
        setCopyState('unavailable');
      }

      return;
    }

    if (changed || copyState === 'unavailable') {
      setCopyState('idle');
    }
  };

  /**
   * Renders the whole panel from the context and the ports, and records what
   * it put on screen.
   *
   * @returns The snapshot of this render.
   */
  const render = (): RunSummarySnapshot => {
    const resolved = resolveRun();

    writeText(titleElement, 'title', copy.title(resolved.outcome));

    if (panel !== null) {
      if (resolved.outcome === null) {
        panel.removeAttribute(runSummaryAttributes.outcome);
      } else {
        panel.setAttribute(runSummaryAttributes.outcome, resolved.outcome);
      }
    }

    writeText(scoreValue, 'scoreValue', copy.scoreValue(resolved.score));
    writeText(
      stageValue,
      'stageValue',
      copy.stageValue(resolved.stageIndex),
    );
    writeText(goalValue, 'goalValue', resolved.goalText);
    renderRelics(resolved.relics);
    renderSeed(resolved.seed);

    const rendered: RunSummarySnapshot = Object.freeze({
      outcome: resolved.outcome,
      score: resolved.score,
      stageIndex: resolved.stageIndex,
      goal: resolved.goal,
      goalText: resolved.goalText,
      seed: resolved.seed,
      relics: Object.freeze(
        resolved.relics.map(
          (entry): RunSummaryRelicRow =>
            Object.freeze({
              id: entry.id,
              slot: entry.slot,
              charges: entry.charges,
              known: entry.known,
            }),
        ),
      ),
      copyState,
      newRunOffered,
    });

    snapshot = rendered;
    reporter.count(RENDERED_METRIC, {
      context: REPORT_CONTEXT,
      relics: rendered.relics.length,
      stage: rendered.stageIndex,
      seed: rendered.seed !== null,
      outcome: rendered.outcome ?? 'unrecorded',
    });

    return rendered;
  };

  /**
   * Reads the members of a context this panel renders from.
   *
   * A context for another state is counted and contributes nothing but its
   * motion value; the panel then renders from the ports alone.
   *
   * @param next Context the lifecycle received.
   * @returns The members read.
   */
  const readContext = (next: ScreenContext): ContextInput => {
    if (next.screen !== SCREEN) {
      reporter.count(FOREIGN_CONTEXT_METRIC, {
        context: REPORT_CONTEXT,
        screen: next.screen,
      });

      return {
        summary: null,
        outcome: null,
        seed: null,
        reducedMotion: next.reducedMotion,
      };
    }

    return {
      summary: next.summary,
      outcome: next.outcome,
      seed: next.seed,
      reducedMotion: next.reducedMotion,
    };
  };

  /**
   * Places focus for this state, through the one deterministic chain
   * ../a11y/focus-manager owns. The marker on the copy control is what the
   * chain resolves, and the motion value decides whether the target is
   * scrolled to smoothly.
   */
  const placeFocus = (): void => {
    if (options.placeFocus === false) {
      return;
    }

    const container = host ?? panel;

    if (container === null) {
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        mount: HOST_MOUNT,
        cause: 'not-built',
      });

      return;
    }

    focusInitial(SCREEN, container, {
      reporter,
      context: REPORT_CONTEXT,
      reducedMotion: readReducedMotion(),
    });
  };

  /**
   * The run's conclusion as one line: the verdict, the score, the stage, the
   * goal, the relic count and whether a seed is on screen.
   *
   * ONE COMPOSER, read by this screen where it announces its own entry and by
   * the router where it reads the line. DL-SUMMARY-11.
   *
   * @param rendered What the last render put on screen.
   * @returns The line.
   */
  const describeConclusion = (rendered: RunSummarySnapshot): string =>
    copy.announcement({
      outcome: rendered.outcome,
      score: rendered.score,
      stage: rendered.stageIndex + 1,
      goal: rendered.goalText,
      relics: rendered.relics.length,
      seedPresent: rendered.seed !== null,
    });

  /**
   * The line the router reads on entry.
   *
   * Reads what is on screen, so the words describe the summary the player is
   * looking at. DL-SUMMARY-11.
   *
   * @returns The line, or `null` before anything has been rendered.
   */
  const announcement = (): string | null =>
    snapshot === null ? null : describeConclusion(snapshot);

  /**
   * Renders the summary, then places focus and announces the conclusion where
   * this screen owns those two steps.
   *
   * @param next Context for this entry.
   */
  const enter = (next: ScreenContext): void => {
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, {
        context: REPORT_CONTEXT,
        member: 'enter',
      });

      return;
    }

    context = readContext(next);
    ensureMounted();

    const rendered = render();

    if (placeFocusOnEntry) {
      placeFocus();
    }

    if (!announced && announceOnEntry) {
      announced = true;
      announce(describeConclusion(rendered));
    }

    reporter.count(ENTERED_METRIC, {
      context: REPORT_CONTEXT,
      trigger: next.trigger,
      refresh: next.refresh,
    });
  };

  /**
   * The in-state refresh path. Idempotent: it re-renders in place, duplicates
   * no relic row, moves no focus and repeats no announcement.
   *
   * @param next Context for this refresh.
   */
  const update = (next: ScreenContext): void => {
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, {
        context: REPORT_CONTEXT,
        member: 'update',
      });

      return;
    }

    context = readContext(next);
    ensureMounted();
    render();
  };

  /** Releases what one visit put on screen, leaving the tree in place. */
  const leave = (): void => {
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, {
        context: REPORT_CONTEXT,
        member: 'leave',
      });

      return;
    }

    announced = false;

    // Every copy attempt still in flight belongs to the visit being left, so
    // its answer writes nothing and announces nothing. DL-SUMMARY-10.
    copyGeneration += 1;
    clearRelics();

    if (relicsEmpty !== null) {
      relicsEmpty.hidden = true;
    }

    setCopyState(renderedSeed === null ? 'unavailable' : 'idle');
    setCopyControlBusy(false);
    reporter.count(LEFT_METRIC, { context: REPORT_CONTEXT });
  };

  /** Removes every node this module added and detaches every listener. */
  const destroy = (): void => {
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, {
        context: REPORT_CONTEXT,
        member: 'destroy',
      });

      return;
    }

    destroyed = true;

    // Every copy attempt still in flight answers into a released panel, so its
    // answer writes nothing and announces nothing. DL-SUMMARY-10.
    copyGeneration += 1;
    clearRelics();

    for (const release of teardown.splice(0)) {
      try {
        release();
      } catch (error) {
        reporter.error('a run summary listener could not be released', error, {
          context: REPORT_CONTEXT,
        });
      }
    }

    if (panel !== null) {
      try {
        panel.remove();
      } catch (error) {
        reporter.error('the run summary panel could not be removed', error, {
          context: REPORT_CONTEXT,
        });
      }
    }

    panel = null;
    titleElement = null;
    scoreValue = null;
    stageValue = null;
    goalValue = null;
    relicList = null;
    relicsEmpty = null;
    seedValue = null;
    seedStatus = null;
    copyButton = null;
    host = null;
    owner = null;
    reporter.count(DESTROYED_METRIC, { context: REPORT_CONTEXT });
  };

  return Object.freeze({
    // A getter.
    get element(): HTMLElement | null {
      return panel;
    },

    mount,
    enter,
    update,
    leave,
    unmount: destroy,
    destroy,

    isMounted: (): boolean => panel !== null,

    readSnapshot: (): RunSummarySnapshot | null => snapshot,

    layout: (): RunSummaryLayout => runSummaryLayout,

    announcement,

    copySeed,
  });
}
