// The run-start screen: the cold-load state of the flow, and the state a run
// returns to from the run summary.
//
// WHAT IT OWNS
//   the children of `#screen-run-start` and nothing else: a begin-run control
//   and an optional seed field. The container itself, its `hidden` attribute,
//   its focus trap and its `role="dialog"` semantics belong to
//   src/ui/screen-router.ts and to index.html.
//
// WHAT IT DOES NOT DO
//   it originates no seed, REDUCES no seed, builds no engine, seeds no
//   generator and starts no run. `originateRunSeed()`,
//   `normalizeEnteredSeed()` and `RunController.startRun()` are none of them
//   called from here and `Math.random` is not read: the field's text is emitted
//   verbatim, `RunController.startRun` is the ONE normaliser, and the seed the
//   run is played under is read back through the `seedInForce` port and
//   reflected into the field.
//
// PROVENANCE of each borrowed construct — what it is, and where it came from:
//   src/run/run-controller.ts   `startRun`'s own reduction of a typed seed, read
//                               back through the `seedInForce` port
//   src/input/keymap.ts         `startRun`, the action name this screen emits,
//                               whose payload is the seed or `undefined`
//   src/ui/screen-router.ts     `SCREEN_MOUNTS.runStart`, the container
//                               selector index.html declares, and
//                               `SCREEN_ANNOUNCEMENTS.runStart`, the entry line
//   src/theme/tokens.ts         `zIndex.screenOverlay`, the rung
//                               style/_screens.scss places `.screen` on
//   style/_screens.scss         `.screen-panel`, `.screen-verdict`,
//                               `.screen-text`, `.screen-label`,
//                               `.screen-field`, `.screen-actions`,
//                               `.screen-button` and `.seed-input`, the whole
//                               visual vocabulary this screen composes from
//   style/_a11y.scss            the focus ring, the interaction states and the
//                               reduced-motion layer every control here takes
//   index.html L77              the movement modalities the help copy names
//
// Traceability rows in docs/TRACEABILITY_MATRIX.md. Every row is target-only:
// the retired sources carried exactly one screen and no navigation model, so
// this module ports no construct.
//   TR-RUNSTART-01  target-only row  `createRunStartScreen()` and the
//                                    `Screen` lifecycle it implements
//   TR-RUNSTART-02  target-only row  the optional seed field, its real label
//                                    and its single normalisation
//   TR-RUNSTART-03  target-only row  the begin-run control and the `startRun`
//                                    emission that carries the seed
//   TR-RUNSTART-04  target-only row  the guarded lookups and the reported
//                                    misses (I12)
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-RUNSTART-01  seed origination left in the run controller, with this
//                   screen emitting `undefined` for an empty field
//   DL-RUNSTART-02  the seed field as the designated initial focus target,
//                   marked and ordered for both placement paths
//   DL-RUNSTART-03  a reduced seed written back into the field and announced
//                   rather than applied silently
//   DL-RUNSTART-04  the entry line taken from `SCREEN_ANNOUNCEMENTS`
//   DL-RUNSTART-05  the seed notice as ordinary text rather than a second
//                   live region
//   DL-RUNSTART-06  the field cleared on `leave`

import type { InputEmitter } from '../../input/input-manager';
import type { InputEventName } from '../../input/keymap';
import { MAX_RUN_SEED_LENGTH } from '../../rng/rng-streams';

// The pre-parse ceiling this screen bounds the field's text to before it tests
// it for presence. The reduction itself is the run controller's.
// DL-RUNSTART-07.
import { MAX_ENTERED_SEED_LENGTH } from '../../run/run-controller';
import { zIndex } from '../../theme/tokens';
import { focusInitial } from '../a11y/focus-manager';
import type { LiveRegionAnnouncer } from '../a11y/live-region';
import type { PreferenceStore, UiReporter } from '../a11y/settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from '../a11y/settings';
import { SCREEN_ANNOUNCEMENTS, SCREEN_MOUNTS } from '../screen-router';
import type {
  RunStartScreenContext,
  Screen,
  ScreenContext,
} from '../screen-router';

/** Label naming this module in every report. */
const REPORT_CONTEXT = 'run-start';

/** State this screen renders, as both name unions spell it. */
const SCREEN_NAME = 'runStart' as const;

const HOST_SELECTOR: string = SCREEN_MOUNTS[SCREEN_NAME];

/** Logical name of the container mount, carried into every report. */
const HOST_MOUNT = 'runStartScreen';

/**
 * The action this screen emits, checked against the emitted-event union at
 * compile time while keeping its literal type for `emit`.
 */
const BEGIN_ACTION = 'startRun' satisfies InputEventName;

/**
 * The rung style/_screens.scss places `.screen` on, read from ../theme/tokens.
 *
 * Exported so a consumer and a test can assert the rung without restating 300.
 * No rule and no inline style is written from here: the stylesheet owns the
 * stacking slot, and this screen never reaches the modal rung above it or the
 * diagnostics rung above that.
 */
export const RUN_START_LAYER: number = zIndex.screenOverlay;

/**
 * Attribute `focusInitial` resolves its marker step against, declared at
 * src/ui/a11y/focus-manager.ts as `FOCUS_INITIAL_ATTRIBUTE`.
 */
const FOCUS_MARKER_ATTRIBUTE = 'data-focus-initial';

/**
 * Element identifiers this screen renders, each unique against the identifiers
 * index.html already declares.
 *
 * Exported so a test, the recorded-gameplay gate and any consumer address the
 * rendered controls by the same names this module writes.
 */
export const RUN_START_IDS = Object.freeze({
  panel: 'run-start-panel',
  title: 'run-start-title',
  seedInput: 'run-start-seed',
  seedHint: 'run-start-seed-hint',
  seedStatus: 'run-start-seed-status',
  begin: 'run-start-begin',
  settings: 'run-start-settings',
  previous: 'run-start-previous',
});

/**
 * The class vocabulary style/_screens.scss declares, referenced by name so no
 * colour, length, radius or duration is stated here.
 */
const CLASSES = Object.freeze({
  panel: 'screen-panel',
  verdict: 'screen-verdict',
  text: 'screen-text',
  label: 'screen-label',
  field: 'screen-field',
  actions: 'screen-actions',
  button: 'screen-button',
  seedInput: 'seed-input',
});

/**
 * Whether the field holds anything besides whitespace.
 *
 * A PRESENCE TEST, not a reduction: it decides whether the player supplied a
 * seed at all, and the value handed on is always the field's own text.
 * `RunController.startRun` remains the only thing that transforms a seed.
 */
const SEED_PRESENT = /\S/u;

/**
 * Longest text the field will hold, as the `maxlength` attribute.
 *
 * The accepted seed domain, so the field cannot hold text the run would refuse
 * to play: a paste above this is cut by the platform, visibly, in the field the
 * player is looking at, rather than being accepted and silently reduced later.
 * `normalizeEnteredSeed()` still bounds what it is handed, because `maxlength`
 * governs user entry alone and a programmatic assignment ignores it.
 * Decision DL-RUNSTART-07.
 */
export const SEED_INPUT_MAX_LENGTH = MAX_RUN_SEED_LENGTH;

/* ==========================================================================
 * 2. Report names
 * ========================================================================== */

/** Counter raised once per completed mount. */
const MOUNTED_METRIC = 'ui.runStart.mounted';

/** Counter raised once per container the document did not supply. */
const MOUNT_MISSING_METRIC = 'ui.runStart.mount_missing';

/** Counter raised once per built subtree. */
const RENDERED_METRIC = 'ui.runStart.rendered';

/** Counter raised once per entry to the state. */
const ENTERED_METRIC = 'ui.runStart.entered';

/** Counter raised once per in-state refresh. */
const UPDATED_METRIC = 'ui.runStart.updated';

/** Counter raised once per exit from the state. */
const LEFT_METRIC = 'ui.runStart.left';

/** Counter raised once per `unmount`. */
const UNMOUNTED_METRIC = 'ui.runStart.unmounted';

/** Counter raised once per begin-run attempt that emitted. */
const BEGIN_METRIC = 'ui.runStart.begin';

/** Counter raised once per begin-run attempt that could not emit. */
const BEGIN_REFUSED_METRIC = 'ui.runStart.begin.refused';

/** Counter raised when the field's text and the seed emitted differ. */
const SEED_ADJUSTED_METRIC = 'ui.runStart.seed.adjusted';

/** Counter raised when nothing was subscribed to the emitted action. */
const NO_SUBSCRIBER_METRIC = 'ui.runStart.startRun.unsubscribed';

/** Counter raised per call that reaches an unmounted screen. */
const AFTER_UNMOUNT_METRIC = 'ui.runStart.after_unmount';

/** Counter raised per lifecycle call carrying another state's context. */
const CONTEXT_MISMATCH_METRIC = 'ui.runStart.context.unexpected';

/** Counter raised per outlet a write needed and did not have. */
const OUTLET_MISSING_METRIC = 'ui.runStart.outlet_missing';

/**
 * Renders a relic count with its noun agreeing in number.
 *
 * @param relics Relics the run just ended held.
 * @returns `1 relic` for one, and `N relics` for every other count.
 */
function describeRelicCount(relics: number): string {
  return relics === 1 ? '1 relic' : `${String(relics)} relics`;
}

/**
 * Every string this screen renders or announces, overridable so a caller can
 * localise the screen without editing this module.
 *
 * `controls` names the four movement modalities and the remapping surface that
 * index.html L77 names, so the two do not disagree about what a player can
 * press. The authenticity notice and the third-party attributions of
 * index.html are not restated here in any form.
 */
export const runStartCopy = Object.freeze({
  /** Heading of the screen. */
  title: 'Start a run',

  /** What a run is. */
  intro:
    'Clear each stage goal to choose a relic. Relics keep firing for the ' +
    'rest of the run, in the order you picked them up.',

  /** How the board is played, in agreement with index.html. */
  controls:
    'Move the tiles with your arrow keys, WASD, the Vim keys H, J, K, L, ' +
    'a swipe, or the on-screen controls. Any key can be remapped from ' +
    'Settings.',

  /** Accessible name of the seed field, stating that it is optional. */
  seedLabel: 'Seed (optional)',

  /**
   * Static description of the seed field, INCLUDING that a seed is public.
   *
   * A seed is shown on the run summary and copied from it by anyone replaying
   * the run, which is what it is for, so the field says so where it is typed
   * rather than leaving a player to discover it afterwards. Decision
   * DL-RUNSTART-11.
   */
  seedHint:
    'Leave this empty for a fresh seed. The same seed played with the same ' +
    'moves gives the same board and the same relic offers. A seed is public: ' +
    'it is shown on the run summary and can be copied from there, so do not ' +
    'type anything personal or secret into it.',

  /** Label of the begin-run control. */
  beginLabel: 'Begin run',

  /**
   * Label of the settings control this screen renders INSIDE its own subtree.
   *
   * The state is modal and its trap holds the subtree, so a trigger outside it
   * cannot be reached; the accessibility settings — remapping, the palettes,
   * number-only mode and reduced motion — must be reachable before a run
   * starts. Decision DL-RUNSTART-08.
   */
  settingsLabel: 'Settings',

  /** Shown and announced when the seed emitted differs from the text typed. */
  seedAdjusted: (seed: string): string => `Seed adjusted to ${seed}.`,

  /** Line announced on entering the state. */
  announcement: SCREEN_ANNOUNCEMENTS[SCREEN_NAME],

  /** Renders the relic count of the run just ended. */
  relicCount: describeRelicCount,

  /** Recaps the run just ended, on a return from the run summary. */
  previous: (score: number, stage: number, relics: number): string =>
    `Previous run: ${String(score)} points, stage ${String(stage)}, ` +
    `${describeRelicCount(relics)}.`,
});

/** The copy this screen renders, as `runStartCopy` declares it. */
export type RunStartCopy = typeof runStartCopy;

/**
 * The part of src/input/input-manager.ts this screen invokes.
 *
 * Narrowed to `emit`: this screen publishes the action, subscribes to nothing,
 * and binds no element other than the two it renders. `InputManager` satisfies
 * it.
 */
export type RunStartInputPort = Pick<InputEmitter, 'emit'>;

/**
 * The part of src/ui/a11y/live-region.ts this screen invokes: the free-text
 * form, which is the variant that carries a screen transition.
 */
export type RunStartAnnouncer = Pick<LiveRegionAnnouncer, 'announceText'>;

/**
 * The part of the preference store this screen consults, read before focus is
 * placed so a reduced-motion session is scrolled without animation.
 */
export type RunStartPreferencePort = Pick<PreferenceStore, 'isReducedMotion'>;

/** What one begin-run attempt did. */
export interface RunStartBegin {
  /** Whether the field held anything besides whitespace. */
  readonly supplied: boolean;

  /**
   * The seed the run is played under, as `seedInForce` read it back, falling
   * back to the text emitted where no reader was supplied. `null` where the
   * field held no seed at all, in which case the run controller originates one.
   */
  readonly seed: string | null;

  /** Whether the seed in force differs from the text the field held. */
  readonly adjusted: boolean;

  /** Subscribers the action reached. `0` means the run was not started. */
  readonly delivered: number;
}

/** Everything the factory accepts. Every member is optional. */
export interface RunStartOptions {
  /**
   * Emitter the `startRun` action is published through. Absent, a begin-run
   * press is reported and nothing is emitted, so the screen still renders and
   * is still navigable.
   */
  readonly input?: RunStartInputPort | null;

  /** Announcer the entry line and any seed adjustment are spoken through. */
  readonly announcer?: RunStartAnnouncer | null;

  /**
   * Reads the seed the run is played under, called immediately after the
   * `startRun` action has been delivered.
   *
   * THE SCREEN NORMALISES NO SEED. `RunController.startRun` reduces what it is
   * given and originates what it is not, so the field's text is emitted verbatim
   * and this is what the field is reflected from. Absent, the field keeps the
   * text the player typed and no adjustment is reported. Decision
   * `DL-RUNSTART-03`.
   */
  readonly seedInForce?: () => string | null;

  /** Store the effective reduced-motion value is read from. */
  readonly preferences?: RunStartPreferencePort | null;

  /**
   * Whether focus is placed on entry. Defaults to `true`.
   *
   * SET FALSE WHERE A CALLER TRAPS THIS CONTAINER. A focus trap records the
   * element that held focus at the moment it engages, so that it can hand focus
   * back on release; a caller that traps the container AFTER this screen has
   * already placed focus inside it records a target inside its own trap, which
   * it cannot restore to and reports. The marked target is also the container's
   * first focusable element — `DL-RUNSTART-02` — so a trap placing focus itself
   * lands on the same element and the entrance is unchanged.
   */
  readonly placeFocus?: boolean;

  /**
   * The container, as an element already resolved or as a selector resolved
   * against `document` through the guarded resolver. Absent, `mount` is
   * expected to supply it, and `HOST_SELECTOR` is the fallback a standalone
   * caller gets.
   */
  readonly host?: Element | string | null;

  /** Document elements are created in. Defaults to the ambient document. */
  readonly document?: Document;

  /** Copy overrides. Any subset of `runStartCopy` may be replaced. */
  readonly copy?: Partial<RunStartCopy>;

  /** Sink every miss, every write and every refusal reports through. */
  readonly reporter?: UiReporter;

  /**
   * Called when the settings control inside this screen is activated. Absent,
   * the control is not rendered, so nothing offers an action that goes nowhere.
   * Decision DL-RUNSTART-08.
   */
  readonly onOpenSettings?: () => void;

  /**
   * Whether this screen announces the entry line. Defaults to `true`. `false`
   * is for a composition whose router reads it, which it takes from
   * `announcement()`. The seed-adjustment notice is left on either way: it
   * reports an action, not an entry. Decision DL-RUNSTART-09.
   */
  readonly announceEntry?: boolean;
}

/**
 * The mounted screen: the router's lifecycle plus the readers a caller and a
 * test drive it through. Every member is safe to call at any time, before
 * `mount` and after `unmount` included.
 */
export interface RunStartScreen extends Screen {
  /** Whether a container resolved and the subtree was built. */
  isMounted(): boolean;

  /** The text the seed field holds, and `''` while nothing is mounted. */
  readSeedValue(): string;

  /** What the last begin-run attempt did, or `null` before the first. */
  readLastBegin(): RunStartBegin | null;

  /**
   * Publishes the field's text verbatim through the `startRun` action, which is
   * the whole of starting a run from this screen, then reflects the seed the run
   * is played under back into the field.
   *
   * Called by the begin-run control and by Enter inside the seed field. It
   * throws for nothing: an absent emitter, an absent field and a raising
   * subscriber are each reported and reflected in the returned record.
   *
   * @returns What the attempt did.
   */
  beginRun(): RunStartBegin;
}

/** The document, where there is one. */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Applies copy overrides over the defaults, one member at a time.
 *
 * @param overrides Any subset of the copy.
 * @returns The frozen copy in force.
 */
function mergeCopy(overrides: Partial<RunStartCopy> | undefined): RunStartCopy {
  if (overrides === undefined) {
    return runStartCopy;
  }

  return Object.freeze({
    title: overrides.title ?? runStartCopy.title,
    intro: overrides.intro ?? runStartCopy.intro,
    controls: overrides.controls ?? runStartCopy.controls,
    seedLabel: overrides.seedLabel ?? runStartCopy.seedLabel,
    seedHint: overrides.seedHint ?? runStartCopy.seedHint,
    beginLabel: overrides.beginLabel ?? runStartCopy.beginLabel,
    settingsLabel: overrides.settingsLabel ?? runStartCopy.settingsLabel,
    seedAdjusted: overrides.seedAdjusted ?? runStartCopy.seedAdjusted,
    announcement: overrides.announcement ?? runStartCopy.announcement,
    relicCount: overrides.relicCount ?? runStartCopy.relicCount,
    previous: overrides.previous ?? runStartCopy.previous,
  });
}

/** The elements one build produced, cached so no write performs a lookup. */
interface RunStartElements {
  /** The bounded reading surface, and the only node appended to the host. */
  readonly panel: HTMLElement;

  /** The optional seed field, and the screen's initial focus target. */
  readonly seedInput: HTMLInputElement;

  /** The seed notice, hidden while it carries no text. */
  readonly seedStatus: HTMLElement;

  /** The previous-run recap, hidden while no run has ended. */
  readonly previous: HTMLElement;

  /** The begin-run control. */
  readonly begin: HTMLButtonElement;

  /**
   * The settings control, and `null` where the caller wired no settings action.
   * DL-RUNSTART-08.
   */
  readonly settings: HTMLButtonElement | null;
}

/**
 * Builds the screen's subtree, in the DOM order its focus contract requires.
 *
 * @param owner Document the elements are created in.
 * @param copy The copy in force.
 * @returns The elements a write addresses.
 */
function buildSubtree(
  owner: Document,
  copy: RunStartCopy,
  withSettings: boolean,
): RunStartElements {
  const panel = owner.createElement('section');

  panel.id = RUN_START_IDS.panel;
  panel.className = CLASSES.panel;

  const title = owner.createElement('h2');

  title.id = RUN_START_IDS.title;
  title.className = CLASSES.verdict;
  title.textContent = copy.title;

  const intro = owner.createElement('p');

  intro.className = CLASSES.text;
  intro.textContent = copy.intro;

  const controls = owner.createElement('p');

  controls.className = CLASSES.text;
  controls.textContent = copy.controls;

  const field = owner.createElement('div');

  field.className = CLASSES.field;

  // A REAL label with a real `for` — not a placeholder and not stylesheet
  // `:after` content, neither of which carries an accessible name.
  const label = owner.createElement('label');

  label.className = CLASSES.label;
  label.htmlFor = RUN_START_IDS.seedInput;
  label.textContent = copy.seedLabel;

  const seedInput = owner.createElement('input');

  seedInput.type = 'text';
  seedInput.id = RUN_START_IDS.seedInput;
  seedInput.className = CLASSES.seedInput;

  // The accepted seed domain as a platform-enforced ceiling on entry, so the
  // field cannot hold more than a run can play. DL-RUNSTART-07.
  seedInput.maxLength = SEED_INPUT_MAX_LENGTH;
  seedInput.autocomplete = 'off';
  seedInput.spellcheck = false;
  seedInput.setAttribute('autocapitalize', 'off');
  seedInput.setAttribute('autocorrect', 'off');
  seedInput.setAttribute('enterkeyhint', 'go');
  seedInput.setAttribute('aria-describedby', RUN_START_IDS.seedHint);
  seedInput.setAttribute(FOCUS_MARKER_ATTRIBUTE, '');

  field.append(label, seedInput);

  const hint = owner.createElement('p');

  hint.id = RUN_START_IDS.seedHint;
  hint.className = CLASSES.text;
  hint.textContent = copy.seedHint;

  // NOT a live region: index.html declares one announcer for the page, and a
  // seed adjustment is spoken through that one.
  const seedStatus = owner.createElement('p');

  seedStatus.id = RUN_START_IDS.seedStatus;
  seedStatus.className = CLASSES.text;
  seedStatus.hidden = true;

  const actions = owner.createElement('div');

  actions.className = CLASSES.actions;

  const begin = owner.createElement('button');

  begin.type = 'button';
  begin.id = RUN_START_IDS.begin;
  begin.className = CLASSES.button;
  begin.textContent = copy.beginLabel;
  actions.append(begin);

  // INSIDE THE TRAPPED SUBTREE, after the begin control in DOM order so the
  // primary action still leads. Rendered only where a settings action was
  // wired, so nothing offers a control that goes nowhere. DL-RUNSTART-08.
  const settings = withSettings ? owner.createElement('button') : null;

  if (settings !== null) {
    settings.type = 'button';
    settings.id = RUN_START_IDS.settings;
    settings.className = CLASSES.button;
    settings.textContent = copy.settingsLabel;
    actions.append(settings);
  }

  const previous = owner.createElement('p');

  previous.id = RUN_START_IDS.previous;
  previous.className = CLASSES.text;
  previous.hidden = true;

  panel.append(
    title,
    intro,
    controls,
    field,
    hint,
    seedStatus,
    actions,
    previous,
  );

  return Object.freeze({
    panel,
    seedInput,
    seedStatus,
    previous,
    begin,
    settings,
  });
}

/**
 * Reads a count a recap renders, refusing a value that would render as `NaN`.
 *
 * @param value Value carried by the summary.
 * @returns The value, or `null` where it is not a finite number.
 */
function readCount(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/**
 * Builds the run-start screen.
 *
 * Nothing is read or written at import time: the container lookup, the subtree
 * and every report happen inside the lifecycle. An absent container, an absent
 * emitter, an absent announcer and an absent document are each reported and
 * skipped, and every member stays safe to call.
 *
 * @param options Ports, container, document, copy and report sink.
 * @returns The screen, whether or not a container resolved.
 * @example
 * ```ts
 * const runStart = createRunStartScreen({ input, announcer, preferences });
 * const router = createScreenRouter({ screens: { runStart } });
 *
 * router.start();
 * ```
 */
export function createRunStartScreen(
  options: RunStartOptions = {},
): RunStartScreen {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const copy = mergeCopy(options.copy);

  const input = options.input ?? null;
  const announcer = options.announcer ?? null;
  const preferences = options.preferences ?? null;
  /** Whether entry places focus, as `RunStartOptions.placeFocus` declares. */
  const placeFocusOnEntry = options.placeFocus !== false;
  const owner = options.document ?? readAmbientDocument();
  const announceOnEntry = options.announceEntry !== false;

  /** The container in force, and `null` while none has resolved. */
  let host: Element | null = null;

  /** The built subtree, and `null` while none has been built. */
  let elements: RunStartElements | null = null;

  /** Removes the two listeners one build attached. */
  let detachListeners: (() => void) | null = null;

  /** What the last begin-run attempt did. */
  let lastBegin: RunStartBegin | null = null;

  /**
   * One token per VISIT: raised on entry and again on departure, so a value
   * read before the begin-run action is delivered and compared with the value
   * after it says whether this screen is still the one on screen.
   *
   * The action is published synchronously and the state machine leaves this
   * state inside that call, so the seed readback below happens after `leave()`
   * has already cleared the field. DL-RUNSTART-10.
   */
  let visit = 0;

  /** Whether `unmount` has been called. */
  let unmounted = false;

  /**
   * Runs one listener body so nothing raises out of an event handler.
   *
   * @param work Body to run.
   * @param member Handler name carried into the report.
   */
  const contain = (work: () => void, member: string): void => {
    try {
      work();
    } catch (error) {
      reporter.error('a run-start handler raised', error, {
        context: REPORT_CONTEXT,
        member,
      });
    }
  };

  /**
   * Resolves a container, guarding a selector through the shared resolver.
   *
   * The guarded form of the unchecked lookups the retired markup contract
   * relied on (I12): a selector that matches nothing returns `null` and is
   * reported with the selector and this module's context attached.
   *
   * @param candidate Element, selector, or nothing.
   * @returns The element, or `null`.
   */
  const resolveHost = (
    candidate: Element | string | null | undefined,
  ): Element | null => {
    if (candidate === null || candidate === undefined) {
      return null;
    }

    if (typeof candidate !== 'string') {
      return candidate;
    }

    return resolveMount<HTMLElement>(candidate, {
      root: owner,
      reporter,
      context: REPORT_CONTEXT,
      name: HOST_MOUNT,
    });
  };

  /** Detaches every listener and removes the one node this module appended. */
  const teardownSubtree = (): void => {
    detachListeners?.();
    detachListeners = null;

    const built = elements;

    elements = null;

    if (built === null) {
      return;
    }

    built.panel.remove();
  };

  /**
   * Adopts a container, rebuilding the subtree where it replaced another.
   *
   * @param candidate Container to hold.
   */
  const adoptHost = (candidate: Element): void => {
    if (host === candidate) {
      return;
    }

    // A replacement container leaves the previous one as index.html declared
    // it: the subtree this module appended there is taken back out first.
    teardownSubtree();
    host = candidate;
  };

  /**
   * Attaches the two listeners this screen owns.
   *
   * Only `click` is bound for the control, which a native `<button>` fires for
   * a pointer press, for Enter and for Space alike, so one listener serves all
   * three and no press is published twice. `Enter` inside the field begins the
   * run as well; `Space` does not: a space is a legal seed character.
   *
   * @param built The subtree the listeners are attached to.
   */
  const attachListeners = (built: RunStartElements): void => {
    const onBegin = (): void => {
      contain((): void => {
        beginRun();
      }, 'begin');
    };

    const onSeedKeydown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter') {
        return;
      }

      event.preventDefault();
      contain((): void => {
        beginRun();
      }, 'seedEnter');
    };

    const onSettings = (): void => {
      contain((): void => {
        options.onOpenSettings?.();
      }, 'settings');
    };

    built.begin.addEventListener('click', onBegin);
    built.seedInput.addEventListener('keydown', onSeedKeydown);
    built.settings?.addEventListener('click', onSettings);

    detachListeners = (): void => {
      built.begin.removeEventListener('click', onBegin);
      built.seedInput.removeEventListener('keydown', onSeedKeydown);
      built.settings?.removeEventListener('click', onSettings);
    };
  };

  /**
   * Builds the subtree once.
   *
   * Idempotent: a second call with a subtree already in place is a no-op,
   * which is what keeps `update` from rebuilding the field and discarding text
   * the player has typed into it.
   *
   * @returns Whether a subtree is in place afterwards.
   */
  const render = (): boolean => {
    if (elements !== null) {
      return true;
    }

    if (host === null) {
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        selector: HOST_SELECTOR,
        cause: 'no-host',
      });

      return false;
    }

    if (owner === null) {
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        selector: HOST_SELECTOR,
        cause: 'no-document',
      });
      reporter.log('warn', 'no document is available to render into', {
        context: REPORT_CONTEXT,
      });

      return false;
    }

    const built = buildSubtree(
      owner,
      copy,
      options.onOpenSettings !== undefined,
    );

    host.append(built.panel);
    elements = built;
    attachListeners(built);
    reporter.count(RENDERED_METRIC, { context: REPORT_CONTEXT });

    return true;
  };

  /**
   * Writes the seed notice, hiding it while it carries no text.
   *
   * @param text Notice to show, or the empty string to take it down.
   */
  const writeStatus = (text: string): void => {
    const built = elements;

    if (built === null) {
      reporter.count(OUTLET_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        outlet: 'seedStatus',
      });

      return;
    }

    built.seedStatus.textContent = text;
    built.seedStatus.hidden = text.length === 0;
  };

  /**
   * Writes the recap of the run just ended, and takes it down where there is
   * none or where its numbers could not be read.
   *
   * @param context The context in force, or `null` where none was supplied.
   */
  const writePrevious = (context: RunStartScreenContext | null): void => {
    const built = elements;

    if (built === null) {
      reporter.count(OUTLET_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        outlet: 'previous',
      });

      return;
    }

    const summary = context === null ? null : context.previous;
    const score = summary === null ? null : readCount(summary.score);
    const stageIndex = summary === null ? null : readCount(summary.stageIndex);

    if (summary === null || score === null || stageIndex === null) {
      built.previous.textContent = '';
      built.previous.hidden = true;

      return;
    }

    // One-based: player-facing copy. The engine's own index stays zero-based
    // everywhere else.
    const relics = Array.isArray(summary.relics) ? summary.relics.length : 0;

    built.previous.textContent = copy.previous(score, stageIndex + 1, relics);
    built.previous.hidden = false;
  };

  /**
   * Speaks one line through the injected announcer.
   *
   * @param text Line to speak. An empty line is not spoken.
   */
  const announce = (text: string): void => {
    if (announcer === null || text.length === 0) {
      return;
    }

    try {
      announcer.announceText(text);
    } catch (error) {
      reporter.error('a run-start announcement raised', error, {
        context: REPORT_CONTEXT,
      });
    }
  };

  /**
   * Reads the effective reduced-motion value: the transition's own value
   * first, then the preference store, and otherwise nothing so the focus layer
   * resolves the platform query itself.
   *
   * @param context The context in force, or `null` where none was supplied.
   * @returns The value, or `undefined` where neither source answered.
   */
  const readReducedMotion = (
    context: RunStartScreenContext | null,
  ): boolean | undefined => {
    if (context !== null && typeof context.reducedMotion === 'boolean') {
      return context.reducedMotion;
    }

    if (preferences === null) {
      return undefined;
    }

    try {
      return preferences.isReducedMotion();
    } catch (error) {
      reporter.error('the reduced-motion read raised', error, {
        context: REPORT_CONTEXT,
      });

      return undefined;
    }
  };

  /**
   * Places focus for this entry, unless the caller placed it.
   *
   * Deterministic: the seed field carries the marker attribute `focusInitial`
   * resolves before every other step, and it is also the first focusable
   * descendant, so a caller that traps the container instead lands on the same
   * element. The effective reduced-motion value decides whether the target is
   * scrolled with animation.
   *
   * `placeFocus: false` hands the placement to that caller, which is the whole
   * of what the option does: nothing else about the entrance changes.
   *
   * @param context The context in force, or `null` where none was supplied.
   */
  const placeFocus = (context: RunStartScreenContext | null): void => {
    // Withheld placement is not a missing outlet: it is a composition saying
    // its router owns entry focus, so it is not reported. Decision
    // DL-RUNSTART-07.
    if (!placeFocusOnEntry) {
      return;
    }

    if (host === null) {
      reporter.count(OUTLET_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        outlet: 'host',
        member: 'focus',
      });

      return;
    }

    focusInitial(SCREEN_NAME, host, {
      reporter,
      context: REPORT_CONTEXT,
      reducedMotion: readReducedMotion(context),
    });
  };

  /**
   * Publishes the `startRun` action.
   *
   * The run itself is started by whoever subscribes: no engine is built here,
   * no generator is seeded and no controller method is called. A missing
   * emitter, a raising subscriber and an action nothing listens to are each
   * reported, and each answers `0`.
   *
   * @param seed Seed to carry, or `null` to carry none so the run controller
   *   originates one.
   * @returns Subscribers the action reached.
   */
  const emitStartRun = (seed: string | null): number => {
    if (input === null) {
      reporter.count(BEGIN_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        cause: 'no-emitter',
      });
      reporter.log('warn', 'no emitter is attached, so no run was started', {
        context: REPORT_CONTEXT,
        action: BEGIN_ACTION,
      });

      return 0;
    }

    try {
      const delivered = input.emit(BEGIN_ACTION, seed ?? undefined);
      const reached = typeof delivered === 'number' ? delivered : 0;

      if (reached === 0) {
        reporter.count(NO_SUBSCRIBER_METRIC, {
          context: REPORT_CONTEXT,
          action: BEGIN_ACTION,
        });
        reporter.log('warn', 'nothing is subscribed to the run-start action', {
          context: REPORT_CONTEXT,
          action: BEGIN_ACTION,
        });
      }

      return reached;
    } catch (error) {
      reporter.count(BEGIN_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        cause: 'raised',
      });
      reporter.error('the run-start emission raised', error, {
        context: REPORT_CONTEXT,
        action: BEGIN_ACTION,
      });

      return 0;
    }
  };

  /**
   * Reads the seed the run is actually being played under, after the action has
   * been delivered.
   *
   * THIS SCREEN NORMALISES NOTHING. `RunController.startRun` applies
   * `normalizeEnteredSeed()` to what it is given, so the field's text is emitted
   * verbatim and the reduced value is read back from here — one normaliser, and
   * it is the controller's. A reader that raises, or that is absent, leaves the
   * field as the player typed it. Decision `DL-RUNSTART-03`.
   *
   * @returns The seed in force, or `null` where none could be read.
   */
  const readSeedInForce = (): string | null => {
    const read = options.seedInForce;

    if (read === undefined) {
      return null;
    }

    try {
      const seed = read();

      return typeof seed === 'string' && seed.length > 0 ? seed : null;
    } catch (error) {
      reporter.count(BEGIN_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        cause: 'seed-readback-raised',
      });
      reporter.error('the seed in force could not be read back', error, {
        context: REPORT_CONTEXT,
      });

      return null;
    }
  };

  /** Records and returns one attempt's outcome. */
  const recordBegin = (record: RunStartBegin): RunStartBegin => {
    const frozen = Object.freeze(record);

    lastBegin = frozen;
    reporter.count(BEGIN_METRIC, {
      context: REPORT_CONTEXT,
      supplied: frozen.supplied,
      adjusted: frozen.adjusted,
      delivered: frozen.delivered,
    });

    return frozen;
  };

  const beginRun = (): RunStartBegin => {
    if (unmounted) {
      reporter.count(AFTER_UNMOUNT_METRIC, {
        context: REPORT_CONTEXT,
        member: 'beginRun',
      });
      reporter.count(BEGIN_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        cause: 'unmounted',
      });

      const refused: RunStartBegin = Object.freeze({
        supplied: false,
        seed: null,
        adjusted: false,
        delivered: 0,
      });

      lastBegin = refused;

      return refused;
    }

    const field = elements === null ? null : elements.seedInput;

    if (field === null) {
      // An absent field is an absent seed, which the run controller answers by
      // originating one, so the run still begins.
      reporter.count(OUTLET_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        outlet: 'seedInput',
        member: 'beginRun',
      });

      return recordBegin({
        supplied: false,
        seed: null,
        adjusted: false,
        delivered: emitStartRun(null),
      });
    }

    // Bounded to the same ceiling `normalizeEnteredSeed()` applies, BEFORE the
    // presence test below reads it. `maxLength` governs user entry alone, so a
    // programmatically assigned value can be arbitrarily long, and the presence
    // test is a whole-string operation. Both steps therefore read the same
    // bounded text, which is also what keeps this test agreeing with the
    // normaliser's own emptiness rule. DL-RUNSTART-01, DL-RUNSTART-07.
    const held = field.value;
    const typed =
      held.length > MAX_ENTERED_SEED_LENGTH
        ? held.slice(0, MAX_ENTERED_SEED_LENGTH)
        : held;

    // A PRESENCE TEST, not a reduction. An empty or whitespace-only field
    // carries no seed at all, so no seed is emitted and the run controller
    // originates one: origination is the controller's, as reduction is.
    // Decision DL-RUNSTART-01.
    if (!SEED_PRESENT.test(typed)) {
      writeStatus('');

      return recordBegin({
        supplied: false,
        seed: null,
        adjusted: false,
        delivered: emitStartRun(null),
      });
    }

    // THE TEXT IS EMITTED VERBATIM. `RunController.startRun` is the one
    // normaliser, so nothing here trims, case-folds, hashes, parses or bounds
    // the value; the reduced seed is read back below.
    const opened = visit;
    const delivered = emitStartRun(typed);
    const inForce = readSeedInForce();
    const seed = inForce ?? typed;
    const adjusted = seed !== typed;

    // THE VISIT THAT PRESSED THE CONTROL. A delivered action begins the run,
    // and the state machine leaves this state inside that same call, so by this
    // point `leave()` has cleared the field for the next visit. Writing the
    // reduced seed into it then re-populated a screen nobody is looking at and
    // a later visit opened carrying a seed its player never typed.
    const showing = visit === opened;

    if (adjusted && showing) {
      // REFLECTED FROM THE CONTROLLER: the seed on screen is the seed the run
      // is played under, read back from the authority that decided it rather
      // than recomputed here. Decision `DL-RUNSTART-03`.
      field.value = seed;
      writeStatus(copy.seedAdjusted(seed));
    } else if (showing) {
      writeStatus('');
    }

    if (adjusted) {
      // ANNOUNCED EITHER WAY. The live region is outside this screen's subtree
      // and outlives the visit, so the reduction is spoken whether or not the
      // field it describes is still on screen. DL-RUNSTART-10.
      announce(copy.seedAdjusted(seed));
      reporter.count(SEED_ADJUSTED_METRIC, {
        context: REPORT_CONTEXT,
        typedLength: typed.length,
        seedLength: seed.length,
        showing,
      });
      reporter.log('info', 'the entered seed was reduced by the run', {
        context: REPORT_CONTEXT,
        typedLength: typed.length,
        seedLength: seed.length,
      });
    }

    return recordBegin({
      supplied: true,
      seed,
      adjusted,
      delivered,
    });
  };

  /**
   * Narrows a lifecycle context to this screen's own.
   *
   * @param context Context received.
   * @param member Lifecycle member carried into the report.
   * @returns The context, or `null` where it was another state's.
   */
  const narrowContext = (
    context: ScreenContext,
    member: string,
  ): RunStartScreenContext | null => {
    if (context === null || typeof context !== 'object') {
      reporter.count(CONTEXT_MISMATCH_METRIC, {
        context: REPORT_CONTEXT,
        member,
        screen: 'absent',
      });

      return null;
    }

    if (context.screen === SCREEN_NAME) {
      return context;
    }

    reporter.count(CONTEXT_MISMATCH_METRIC, {
      context: REPORT_CONTEXT,
      member,
      screen: context.screen,
    });

    return null;
  };

  /**
   * Adopts the container a context carries, where nothing has been mounted.
   *
   * @param context The context in force, or `null` where none was supplied.
   */
  const adoptContextHost = (context: RunStartScreenContext | null): void => {
    const candidate = resolveHost(context === null ? null : context.host);

    if (candidate === null) {
      return;
    }

    adoptHost(candidate);
  };

  /**
   * Reports a call that arrived after `unmount`.
   *
   * @param member Lifecycle member carried into the report.
   * @returns Whether the call was refused.
   */
  const refuseAfterUnmount = (member: string): boolean => {
    if (!unmounted) {
      return false;
    }

    reporter.count(AFTER_UNMOUNT_METRIC, {
      context: REPORT_CONTEXT,
      member,
    });

    return true;
  };

  const mount = (target: Element): void => {
    if (refuseAfterUnmount('mount')) {
      return;
    }

    // The router hands the container it already resolved; the two fallbacks
    // serve a caller that mounts this screen on its own.
    const resolved =
      resolveHost(target) ??
      resolveHost(options.host) ??
      resolveHost(HOST_SELECTOR);

    if (resolved === null) {
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        selector: HOST_SELECTOR,
        cause: 'no-match',
      });
      reporter.log('warn', 'the run-start container was not supplied', {
        context: REPORT_CONTEXT,
        selector: HOST_SELECTOR,
      });

      return;
    }

    adoptHost(resolved);

    if (!render()) {
      return;
    }

    reporter.count(MOUNTED_METRIC, {
      context: REPORT_CONTEXT,
      layer: RUN_START_LAYER,
    });
  };

  /**
   * The line the router reads on entry.
   *
   * `SCREEN_ANNOUNCEMENTS.runStart` is what `copy.announcement` already
   * carries, so the words are identical whichever layer speaks them.
   * DL-RUNSTART-04.
   *
   * @returns The entry line.
   */
  const announcement = (): string | null => copy.announcement;

  const enter = (context: ScreenContext): void => {
    if (refuseAfterUnmount('enter')) {
      return;
    }

    const entered = narrowContext(context, 'enter');

    // A NEW VISIT. Raised before anything renders, so feedback owed to the
    // previous visit cannot be written into this one.
    visit += 1;

    adoptContextHost(entered);

    if (!render()) {
      reporter.log('warn', 'the run-start screen entered with no container', {
        context: REPORT_CONTEXT,
        selector: HOST_SELECTOR,
      });

      return;
    }

    // A visit starts with no notice standing: the previous visit's seed
    // adjustment does not describe the field as it now is.
    writeStatus('');
    writePrevious(entered);

    // Both are the router's where it owns them, and this screen's where it does
    // not: the words the router reads come from `announcement()` below.
    // Decisions DL-RUNSTART-04, DL-RUNSTART-09.
    if (placeFocusOnEntry) {
      placeFocus(entered);
    }

    if (announceOnEntry) {
      announce(copy.announcement);
    }

    reporter.count(ENTERED_METRIC, {
      context: REPORT_CONTEXT,
      trigger: entered === null ? 'unknown' : entered.trigger,
      reducedMotion: readReducedMotion(entered) ?? false,
      previous: entered !== null && entered.previous !== null,
    });
  };

  const update = (context: ScreenContext): void => {
    if (refuseAfterUnmount('update')) {
      return;
    }

    const refreshed = narrowContext(context, 'update');

    adoptContextHost(refreshed);

    if (!render()) {
      return;
    }

    // The field is not written here, and neither is focus moved nor the entry
    // line re-announced: a refresh that rebuilt the field would discard text
    // the player has already typed into it.
    writePrevious(refreshed);

    reporter.count(UPDATED_METRIC, {
      context: REPORT_CONTEXT,
      trigger: refreshed === null ? 'unknown' : refreshed.trigger,
      previous: refreshed !== null && refreshed.previous !== null,
    });
  };

  const leave = (): void => {
    if (refuseAfterUnmount('leave')) {
      return;
    }

    // THE VISIT IS OVER. Raised here as well as on entry, so a begin-run
    // attempt still unwinding through this departure sees a token that moved.
    visit += 1;

    const built = elements;

    if (built === null) {
      reporter.count(OUTLET_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        outlet: 'seedInput',
        member: 'leave',
      });
    } else {
      // The visit's own state is cleared: a later visit opens on an empty
      // field and a run begun from it carries no seed the player did not type.
      built.seedInput.value = '';
      writeStatus('');
    }

    reporter.count(LEFT_METRIC, { context: REPORT_CONTEXT });
  };

  const unmount = (): void => {
    if (refuseAfterUnmount('unmount')) {
      return;
    }

    unmounted = true;
    teardownSubtree();
    host = null;
    reporter.count(UNMOUNTED_METRIC, { context: REPORT_CONTEXT });
  };

  return Object.freeze({
    mount,
    enter,
    update,
    announcement,
    leave,
    unmount,
    isMounted: (): boolean => elements !== null,
    readSeedValue: (): string =>
      elements === null ? '' : elements.seedInput.value,
    readLastBegin: (): RunStartBegin | null => lastBegin,
    beginRun,
  });
}
