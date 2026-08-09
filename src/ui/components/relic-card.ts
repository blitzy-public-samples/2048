// The visible face of one relic, on the three surfaces a run shows it on: the
// choose-1-of-3 reward card, the pickup-ordered HUD tray item, and the
// read-only row the run summary lists a collected relic as.
//
// A component, not a screen. It declares no router lifecycle and implements no
// `Screen` of src/ui/screen-router.ts; a screen mounts it.
//
// WHAT IT OWNS
//   the element tree one relic occupies on each of the three surfaces, and the
//   accessible name, description association and badge text that tree carries;
//   the entrance marker, applied only where motion is permitted.
//
// WHAT IT DOES NOT OWN
//   `selectReward` and every other element-to-action binding, which
//   src/input/on-screen-controls.ts is the sole owner of: an activation calls
//   the injected `onSelect` and stops there;
//   `.restart-button`, `.retry-button`, `.keep-playing-button` and the
//   direction pad, all of which that module already creates;
//   focus containment and restore, which the reward screen requests from
//   `trap()` of src/ui/a11y/focus-manager.ts;
//   `.game-message`, whose terminal states src/ui/screen-router.ts subsumes;
//   live charge and `state` values, which src/relics/relic-registry.ts holds
//   and this module only reads;
//   pickup order, which `RelicRegistry.active()` returns and no member here
//   re-sorts by rarity, name, charges or family.
//
// A relic arrives as the SEVEN-MEMBER declaration of
// src/relics/relic-types.ts — `id`, `name`, `rarity`, `description`, `hooks`,
// `charges` and `state` — and is never widened: there is no family member, no
// icon and no display name, and a surface needing more receives it as a
// separate option. Badges are derived by iterating `HOOK_NAMES` of
// src/engine/hooks.ts and testing membership in `hooks`, so badge order is the
// order one turn reaches the six hooks in and an unrecognised key never
// renders.
//
// This module declares no colour, length, radius, duration or z-index. Every
// one it relies on is declared in style/_reward.scss, style/_hud.scss,
// style/_summary.scss and style/_a11y.scss and is reached through the class
// names and attributes below; the one colour that crosses into script is the
// rarity accent, which `resolveRarityColor` of src/theme/themes.ts samples off
// the shared ramp, and no member writes a colour into the tree. It names no
// observability module — the report sink is injected — reads no storage, holds
// no timer, and performs no lookup, no `matchMedia` call and no DOM write at
// import time.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of this
// module's area enumerated. All are target-only: no construct of js/ rendered a
// relic, so the declared origin is requirements R3, R8 and R9 and AAP 0.6.2.6
// Group 6.
//   TR-CARD-01  index.html L31, L38, L39      the hrefless `<a>` controls,
//               (source branch)                whose successor here is a real
//                                              `<button type="button">`
//   TR-CARD-02  style/main.scss L159-L168     the `button` mixin the reward
//               (source branch)                card's surface is compiled from
//   TR-CARD-03  style/main.scss L109-L115     the `:after` captions, invisible
//               (source branch)                to assistive technology, whose
//                                              successor is the real text
//                                              every label here carries
//   TR-CARD-04  style/main.scss L434-L452     the `pop` vocabulary the
//               (source branch)                entrance marker names
//   TR-CARD-05  js/html_actuator.js L3-L4     the unchecked host lookups,
//               (source branch)                guarded here by `resolveMount`
//   TR-CARD-06  index.html L24-L25            the retained score surfaces the
//               (source branch)                tray is rendered alongside
//   TR-CARD-07  target-only row               `createRelicCard` and the three
//                                              variant trees
//   TR-CARD-08  target-only row               `createRelicCardGrid` and its
//                                              supplied-order rendering
//   TR-CARD-09  target-only row               `createRelicTrayItem`, its slot
//                                              text and its three charge
//                                              states
//   TR-CARD-10  target-only row               the `HOOK_NAMES`-ordered badges
//   TR-CARD-11  target-only row               the ramp-derived rarity accent
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-CARD-01  the reward card rendered as a real `<button type="button">`,
//               with the tray row and the summary row left non-interactive
//   DL-CARD-02  the accessible name carrying the relic's name and tier, with
//               the description and the badge row associated by reference
//   DL-CARD-03  keyboard activation installed with `preventDefault` and a
//               key-activation guard
//   DL-CARD-04  the entrance marker applied only where motion is permitted,
//               beside the stylesheet's own `motion-allowed` gate
//   DL-CARD-05  the rarity accent sampled from the shared ramp and exposed to
//               callers rather than written into the tree
//   DL-CARD-06  an absent `charges` rendered as no counter and `0` rendered as
//               an exhausted counter

import { HOOK_NAMES } from '../../engine/hooks';
import type { HookName } from '../../engine/hooks';
import { RARITIES } from '../../relics/relic-types';
import type { ActiveRelic, Rarity, Relic } from '../../relics/relic-types';
import { resolveRarityColor } from '../../theme/themes';
import type { ThemeId } from '../../theme/themes';
import { collectFocusable } from '../a11y/focus-manager';
import { VISUALLY_HIDDEN_CLASS } from '../a11y/live-region';
import type { LiveRegionAnnouncer } from '../a11y/live-region';
import type { PreferenceStore, UiReporter } from '../a11y/settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from '../a11y/settings';

/* ==========================================================================
 * 1. Class names, attributes and selectors
 * ========================================================================== */

/**
 * Every class this module applies, so style/_reward.scss, style/_hud.scss,
 * style/_summary.scss and the suites share one spelling.
 *
 * `entrance` is the only name with no rule of its own: it marks a card the
 * entrance was applied to, beside the `pop` animation style/_reward.scss
 * declares inside `motion-allowed`.
 */
export const relicCardClasses = Object.freeze({
  /** List the reward offers are rendered into. style/_reward.scss. */
  offers: 'reward-offers',

  /** One offer's list item. style/_reward.scss. */
  offer: 'reward-offer',

  /** The reward card itself, a `<button>`. style/_reward.scss. */
  card: 'relic-card',

  /** Keycap and name row. style/_reward.scss. */
  header: 'relic-card-header',

  /** The keycap digit `selectReward` binds. style/_reward.scss. */
  shortcut: 'relic-card-shortcut',

  /** The relic's name on the reward card. style/_reward.scss. */
  name: 'relic-card-name',

  /** Chip row holding the tier and, where present, the budget. */
  meta: 'relic-card-meta',

  /** The tier chip. style/_reward.scss. */
  rarity: 'relic-card-rarity',

  /** The charge chip. style/_reward.scss. */
  charges: 'relic-card-charges',

  /** The clamped description. style/_reward.scss. */
  description: 'relic-card-description',

  /** Badge row, one badge per bound hook. style/_reward.scss. */
  hooks: 'relic-card-hooks',

  /** One hook badge. style/_reward.scss. */
  hookBadge: 'relic-hook-badge',

  /** Marks a card the entrance was applied to. */
  entrance: 'relic-card-enter',

  /** One tray row. style/_hud.scss. */
  trayItem: 'relic-tray-item',

  /** The tray row's interior. style/_hud.scss. */
  trayControl: 'relic-tray-control',

  /** The relic's name on the tray. style/_hud.scss. */
  trayName: 'relic-tray-name',

  /** The remaining-charge count on the tray. style/_hud.scss. */
  trayCharges: 'relic-tray-charges',

  /** One summary row. style/_summary.scss. */
  summaryItem: 'run-summary-relic',

  /** The summary row's own layout element. style/_summary.scss. */
  summaryRow: 'run-summary-relic-row',

  /** The relic's name on the summary row. style/_summary.scss. */
  summaryName: 'run-summary-relic-name',

  /** The tier on the summary row. style/_summary.scss. */
  summaryRarity: 'run-summary-relic-rarity',

  /** The remaining charges on the summary row. style/_summary.scss. */
  summaryCharges: 'run-summary-relic-charges',

  /** The visually-hidden utility of style/_a11y.scss, imported not restated. */
  visuallyHidden: VISUALLY_HIDDEN_CLASS,
});

/**
 * Every attribute this module writes. Each is one style/_reward.scss or
 * style/_hud.scss already reads, or one src/ui/screen-router.ts already
 * resolves a pressed card by.
 */
export const relicCardAttributes = Object.freeze({
  /** The tier both stylesheets draw their accent from. */
  rarity: 'data-rarity',

  /** The relic's identifier, which a consumer resolves a press by. */
  relicId: 'data-relic-id',

  /** Zero-based offer position, which the keycap digit addresses. */
  offerIndex: 'data-offer-index',

  /** Remaining charges, where `"0"` is the exhausted state. */
  charges: 'data-charges',
});

/** Selector the reward grid's host is resolved at. index.html L99. */
export const RELIC_CARD_GRID_HOST_SELECTOR = '#screen-reward';

/** Selector the tray row's host is resolved at. index.html L49. */
export const RELIC_TRAY_HOST_SELECTOR = '#relic-tray';

/** Label naming this module in every report. */
const REPORT_CONTEXT = 'relic-card';

/** Logical name the grid's host is reported under. */
const GRID_MOUNT = 'rewardOffers';

/** Logical name the tray row's host is reported under. */
const TRAY_MOUNT = 'relicTray';

/** Logical name a card's own host is reported under. */
const CARD_MOUNT = 'relicCardHost';

/** Attribute naming an element directly. */
const LABEL_ATTRIBUTE = 'aria-label';

/** Attribute naming an element by reference. */
const DESCRIBED_BY_ATTRIBUTE = 'aria-describedby';

/** Attribute a chosen card carries. style/_reward.scss reads it. */
const PRESSED_ATTRIBUTE = 'aria-pressed';

/** Attribute a refused card carries. style/_reward.scss reads it. */
const DISABLED_ATTRIBUTE = 'aria-disabled';

/** Attribute keeping the keycap digit out of the announcement. */
const HIDDEN_ATTRIBUTE = 'aria-hidden';

/** Value both boolean ARIA attributes above are written with. */
const ARIA_TRUE = 'true';

/** Id prefix of the element a card's description is associated by. */
const DESCRIPTION_ID_PREFIX = 'relic-card-description-';

/** Id prefix of the element a card's badge row is associated by. */
const HOOKS_ID_PREFIX = 'relic-card-hooks-';

/** Keys a native control is activated by. src/input/on-screen-controls.ts. */
const ACTIVATION_KEYS: ReadonlySet<string> = new Set([
  'Enter',
  ' ',
  'Spacebar',
]);

/**
 * Raised once per element pair an id is generated for.
 *
 * Module state, not import-time work: no lookup, no query and no DOM write
 * happens here.
 */
let idSequence = 0;

/* ==========================================================================
 * 2. Copy
 * ========================================================================== */

/**
 * Every string this module renders.
 *
 * Each default is the string the surface it belongs to already carries, so one
 * relic reads the same wherever it appears: `rarity` and `charges` are the
 * reward copy of src/ui/screen-router.ts, and `rarityText` and
 * `chargesRemaining` are the HUD copy of src/ui/screens/hud.ts.
 */
export interface RelicCardCopy {
  /** Renders a tier as a chip's visible label. */
  readonly rarity: (rarity: string) => string;

  /** Renders a tier as text, where an accent carries it visually. */
  readonly rarityText: (rarity: string) => string;

  /** Renders a starting charge budget as the reward card's chip. */
  readonly charges: (charges: number) => string;

  /** Renders remaining charges as the tray's and the summary's count. */
  readonly chargesRemaining: (charges: number) => string;

  /** Text a relic whose budget is spent carries beside its count. */
  readonly exhausted: string;

  /** Names the badge row for a reader that cannot see it is a row. */
  readonly hooksLabel: string;

  /**
   * Written between two adjacent runs of text that would otherwise be read as
   * one word: the badge row's label and its badges, and the tray and summary
   * rows' own runs.
   */
  readonly separator: string;

  /** Renders a one-based pickup slot as text. */
  readonly slot: (slot: number) => string;

  /**
   * Renders a card's accessible name.
   *
   * @param name The relic's name.
   * @param rarity The tier, already rendered by `rarity`.
   * @param charges The charge label, already rendered, or an empty string
   *   where the relic carries no budget.
   */
  readonly accessibleName: (
    name: string,
    rarity: string,
    charges: string,
  ) => string;
}

/** The copy in force where a caller overrides none of it. */
export const defaultRelicCardCopy: RelicCardCopy = Object.freeze({
  rarity: (rarity: string): string => rarity.replace(/-/gu, ' '),
  rarityText: (rarity: string): string => `Rarity: ${rarity}`,
  charges: (charges: number): string =>
    `${charges} ${charges === 1 ? 'charge' : 'charges'}`,
  chargesRemaining: (charges: number): string => `${charges} left`,
  exhausted: 'Exhausted',
  hooksLabel: 'Fires on',
  separator: ', ',
  slot: (slot: number): string => `Slot ${slot}`,
  accessibleName: (name: string, rarity: string, charges: string): string =>
    charges.length === 0
      ? `${name}, ${rarity} relic`
      : `${name}, ${rarity} relic, ${charges}`,
});

/* ==========================================================================
 * 3. Report names
 * ========================================================================== */

/** Counter raised once per card rendered. */
const CARD_RENDERED_METRIC = 'ui.relicCard.rendered';

/** Counter raised once per activation this module reported out. */
const CARD_SELECTED_METRIC = 'ui.relicCard.selected';

/** Counter raised per activation refused, carrying the reason. */
const CARD_REFUSED_METRIC = 'ui.relicCard.selection_refused';

/** Counter raised per host the document did not supply. */
const MOUNT_MISSING_METRIC = 'ui.relicCard.mount_missing';

/** Counter raised where no document could create the tree. */
const NO_DOCUMENT_METRIC = 'ui.relicCard.no_document';

/** Counter raised per tier outside the four `RARITIES` carries. */
const RARITY_UNKNOWN_METRIC = 'ui.relicCard.rarity_unknown';

/** Counter raised per accent the active theme could not resolve. */
const ACCENT_UNRESOLVED_METRIC = 'ui.relicCard.accent_unresolved';

/** Counter raised per call that reaches a destroyed component. */
const AFTER_DESTROY_METRIC = 'ui.relicCard.write_after_destroy';

/** Counter raised once per `destroy`. */
const DESTROYED_METRIC = 'ui.relicCard.destroyed';

/** Counter raised once per grid rendered, carrying the offer count. */
const GRID_RENDERED_METRIC = 'ui.relicCardGrid.rendered';

/** Counter raised per `focusFirst`, carrying whether focus was taken. */
const GRID_FOCUS_METRIC = 'ui.relicCardGrid.focus_first';

/** Counter raised once per grid `destroy`. */
const GRID_DESTROYED_METRIC = 'ui.relicCardGrid.destroyed';

/** Counter raised once per tray row rendered. */
const TRAY_RENDERED_METRIC = 'ui.relicTrayItem.rendered';

/** Counter raised once per tray row `destroy`. */
const TRAY_DESTROYED_METRIC = 'ui.relicTrayItem.destroyed';

/* ==========================================================================
 * 4. Public API
 * ========================================================================== */

/**
 * Which surface a relic is being rendered on.
 *
 * `reward` is the selectable offer, `tray` the owned relic the HUD lists in
 * pickup order, and `summary` the read-only row the run summary collects.
 */
export type RelicCardVariant = 'reward' | 'tray' | 'summary';

/** Every variant, in the order a run reaches them. */
export const RELIC_CARD_VARIANTS: readonly RelicCardVariant[] = Object.freeze([
  'reward',
  'tray',
  'summary',
] as const);

/** The collaborators every factory accepts, each with a safe default. */
export interface RelicCardSharedOptions {
  /**
   * Document the tree is created in. Defaults to a supplied host's own
   * document, and then to the ambient one; outside a browser, and with neither
   * supplied, nothing is created and the absence is reported.
   */
  readonly document?: Document | null;

  /**
   * Host the created root is appended to, already resolved. `null` marks a
   * host the caller looked for and did not find, which is reported.
   *
   * src/ui/screen-router.ts is the authority that resolves and injects
   * elements downward, so an injected host takes no lookup of its own.
   */
  readonly host?: Element | null;

  /**
   * Selector the host is resolved at through `resolveMount` where none is
   * injected. index.html is the authority for every selector.
   */
  readonly hostSelector?: string;

  /** Sink every miss, refusal and degradation is reported through. */
  readonly reporter?: UiReporter;

  /**
   * Region a selection is announced through. Absent, the announcement is
   * skipped; nothing is written to a console in its place.
   */
  readonly announcer?: LiveRegionAnnouncer | null;

  /**
   * Store the effective reduced-motion value is read from, and subscribed to
   * so the entrance marker follows a change.
   */
  readonly preferences?: PreferenceStore | null;

  /**
   * Reduced-motion value that overrides both the store and the media query.
   * `true` withholds the entrance marker.
   */
  readonly reducedMotion?: boolean;

  /** Palette the rarity accent is sampled under. Defaults to the active one. */
  readonly theme?: ThemeId;

  /** Overrides for any subset of the copy. */
  readonly copy?: Partial<RelicCardCopy>;
}

/** Everything `createRelicCard` accepts. */
export interface RelicCardOptions extends RelicCardSharedOptions {
  /**
   * The relic to render, as its family declared it. Used as given: no member
   * is added, removed or rewritten, and the same object is handed back to
   * `onSelect`.
   */
  readonly relic: Relic;

  /** Surface to render for. Defaults to `'reward'`. */
  readonly variant?: RelicCardVariant;

  /**
   * Zero-based position in the drawn offer, rendered as the keycap digit
   * `selectReward` binds and written to `data-offer-index`. Absent, the card
   * carries no keycap.
   */
  readonly index?: number;

  /**
   * One-based pickup slot, rendered as text. Absent, no slot text is written.
   */
  readonly slot?: number;

  /**
   * Charges remaining, as src/relics/relic-registry.ts holds them. Overrides
   * the declaration's own budget, and `0` renders the exhausted state; absent,
   * the declaration's `charges` is rendered, and a declaration carrying none
   * renders no counter at all.
   */
  readonly charges?: number;

  /** Whether the card starts marked as the chosen one. */
  readonly selected?: boolean;

  /** Whether the card starts refusing activation. */
  readonly disabled?: boolean;

  /**
   * Called with the relic, unchanged, on every activation of a `reward` card.
   *
   * The whole of what an activation does here: this module emits no input
   * action and binds no selector, and the screen that receives this callback
   * decides what to publish.
   */
  readonly onSelect?: (relic: Relic) => void;
}

/** One rendered relic. Every member is safe to call at any time. */
export interface RelicCard {
  /**
   * The created root: the `<button>` for `reward`, and the `<li>` for `tray`
   * and `summary`. `null` where no document was available to create it.
   */
  readonly element: HTMLElement | null;

  /** The surface this card was rendered for. */
  readonly variant: RelicCardVariant;

  /** The relic on screen, as the caller supplied it. */
  relic(): Relic;

  /**
   * Re-renders the card for a relic.
   *
   * @param relic Relic to show, used as given.
   * @param charges Charges remaining, where the caller tracks them. Absent, the
   *   declaration's own budget is rendered.
   * @param slot One-based pickup slot. Absent, the slot the card was created
   *   with stands.
   */
  update(relic: Relic, charges?: number, slot?: number): void;

  /**
   * Marks the card as chosen, which style/_reward.scss dresses through
   * `aria-pressed`.
   *
   * @param selected Whether this card is the chosen one.
   */
  setSelected(selected: boolean): void;

  /**
   * Withdraws or restores activation. A withdrawn card stays focusable and
   * announceable, as style/_reward.scss's `aria-disabled` block expects.
   *
   * @param disabled Whether the card refuses activation.
   */
  setDisabled(disabled: boolean): void;

  /**
   * Moves focus to the card.
   *
   * @returns Whether focus was taken.
   */
  focus(): boolean;

  /**
   * The tier's accent under the palette in force, sampled off the shared ramp
   * by `resolveRarityColor` of src/theme/themes.ts.
   *
   * @returns The accent as 6-digit hex, or an empty string where the tier or
   *   the palette could not be resolved, which is reported.
   */
  rarityAccent(): string;

  /**
   * Removes the created nodes and releases every subscription. Every later
   * call is a reported no-op, and calling it more than once is harmless.
   */
  destroy(): void;
}

/** Everything `createRelicCardGrid` accepts. */
export interface RelicCardGridOptions extends RelicCardSharedOptions {
  /**
   * The drawn offer, rendered IN THE ORDER SUPPLIED — the order
   * src/relics/relic-draw.ts sampled it in. No member re-sorts it. Defaults to
   * an empty offer, which renders an empty list.
   */
  readonly relics?: readonly Relic[];

  /** Called with the chosen relic, unchanged. */
  readonly onSelect?: (relic: Relic) => void;
}

/** One rendered offer. */
export interface RelicCardGrid {
  /**
   * The created list, `ul.reward-offers`. `null` where no document was
   * available to create it.
   */
  readonly element: HTMLElement | null;

  /** The cards on screen, in the order they were supplied. */
  cards(): readonly RelicCard[];

  /** The relics on screen, in the order they were supplied. */
  relics(): readonly Relic[];

  /**
   * Re-renders the list.
   *
   * @param relics Offer to show, rendered in the order supplied.
   */
  update(relics: readonly Relic[]): void;

  /**
   * Moves focus to the first card that can take it.
   *
   * @returns Whether focus was taken.
   */
  focusFirst(): boolean;

  /** Removes every card and the list itself. */
  destroy(): void;
}

/** Everything `createRelicTrayItem` accepts. */
export interface RelicTrayItemOptions extends RelicCardSharedOptions {
  /**
   * The held relic, as `RelicRegistry.active()` returns it. Its
   * `pickupOrder` is rendered as the row's slot and its `charges` as the
   * count; neither is recomputed here.
   */
  readonly relic: ActiveRelic;
}

/** One rendered tray row. */
export interface RelicTrayItem {
  /**
   * The created row, `li.relic-tray-item`. `null` where no document was
   * available to create it.
   */
  readonly element: HTMLElement | null;

  /** The held relic on screen, as the caller supplied it. */
  relic(): ActiveRelic;

  /**
   * Re-renders the row.
   *
   * @param activeRelic Held relic to show, used as given.
   */
  update(activeRelic: ActiveRelic): void;

  /**
   * The tier's accent under the palette in force.
   *
   * @returns The accent as 6-digit hex, or an empty string where it could not
   *   be resolved.
   */
  rarityAccent(): string;

  /** Removes the created row. */
  destroy(): void;
}

/* ==========================================================================
 * 5. Shared internals
 * ========================================================================== */

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
  overrides: Partial<RelicCardCopy> | undefined,
): RelicCardCopy {
  return overrides === undefined
    ? defaultRelicCardCopy
    : Object.freeze({ ...defaultRelicCardCopy, ...overrides });
}

/**
 * Resolves the document the tree is created in: the injected one, then a
 * supplied host's own, then the ambient one.
 *
 * @param options Options the factory received.
 * @returns The document, or `null` where none is available.
 */
function resolveDocument(options: RelicCardSharedOptions): Document | null {
  const supplied = options.document ?? null;

  if (supplied !== null) {
    return supplied;
  }

  const host = options.host ?? null;

  return host === null ? readAmbientDocument() : host.ownerDocument;
}

/** One host lookup, as data. */
interface HostRequest {
  /** Element the caller injected, `null` for a miss it already made. */
  readonly host: Element | null | undefined;

  /** Selector the lookup runs at where no element was injected. */
  readonly selector: string | undefined;

  /** Logical name carried into every report. */
  readonly name: string;

  /** Root the lookup searches. */
  readonly root: Document | null;
}

/**
 * Resolves the host the created root is appended to.
 *
 * The guarded form of the lookups at js/html_actuator.js L3-L4: a miss returns
 * `null`, is reported with the selector attached, and leaves the factory
 * returning a usable component whose root is detached.
 *
 * @param request The lookup to run.
 * @param reporter Contained sink.
 * @returns The host, or `null`.
 */
function resolveHost(
  request: HostRequest,
  reporter: UiReporter,
): Element | null {
  if (request.host !== undefined) {
    if (request.host === null) {
      reporter.log('warn', 'relic card host supplied as absent', {
        context: REPORT_CONTEXT,
        mount: request.name,
        selector: request.selector ?? '',
      });
      reporter.count(MOUNT_MISSING_METRIC, {
        context: REPORT_CONTEXT,
        mount: request.name,
        reason: 'supplied-null',
      });
    }

    return request.host;
  }

  const selector = request.selector;

  if (selector === undefined || selector.length === 0) {
    return null;
  }

  const found = resolveMount<HTMLElement>(selector, {
    root: request.root,
    reporter,
    context: REPORT_CONTEXT,
    name: request.name,
  });

  if (found === null) {
    reporter.log('warn', 'relic card host not found', {
      context: REPORT_CONTEXT,
      mount: request.name,
      selector,
    });
    reporter.count(MOUNT_MISSING_METRIC, {
      context: REPORT_CONTEXT,
      mount: request.name,
      selector,
      reason: 'no-match',
    });
  }

  return found;
}

/**
 * Whether a value is one of the four tiers `RARITIES` carries.
 *
 * @param value Tier to test.
 * @returns Whether the tier is one of the four.
 */
function isKnownRarity(value: string): value is Rarity {
  return RARITIES.some((tier): boolean => tier === value);
}

/**
 * Reads a relic's tier, reporting one the ladder does not carry.
 *
 * The value is returned either way: `data-rarity` states what the data says,
 * and the report names the mismatch.
 *
 * @param rarity Tier as the relic declares it.
 * @param relicId Identifier carried into the report.
 * @param reporter Contained sink.
 * @returns The tier, trimmed.
 */
function readRarity(
  rarity: string,
  relicId: string,
  reporter: UiReporter,
): string {
  const trimmed = typeof rarity === 'string' ? rarity.trim() : '';

  if (trimmed.length > 0 && !isKnownRarity(trimmed)) {
    reporter.log('warn', 'relic carries a tier outside the ladder', {
      context: REPORT_CONTEXT,
      relicId,
      rarity: trimmed,
    });
    reporter.count(RARITY_UNKNOWN_METRIC, {
      context: REPORT_CONTEXT,
      rarity: trimmed,
    });
  }

  return trimmed;
}

/**
 * The hooks a relic binds, IN `HOOK_NAMES` ORDER.
 *
 * Iterates the fixed tuple and tests membership, so badge order is the order
 * one turn reaches the six hooks in whatever order a family module wrote them,
 * and a key outside the six never renders.
 *
 * @param hooks The relic's handler table.
 * @returns The bound hook names, frozen.
 */
function boundHooks(hooks: unknown): readonly HookName[] {
  if (hooks === null || typeof hooks !== 'object') {
    return Object.freeze([]);
  }

  const table: Readonly<Record<string, unknown>> = hooks as Readonly<
    Record<string, unknown>
  >;

  return Object.freeze(
    HOOK_NAMES.filter(
      (name: HookName): boolean => typeof table[name] === 'function',
    ),
  );
}

/**
 * Reads a value as a record of unknown members, and an empty record from
 * anything that is not an object, so every read below is total.
 *
 * @param value Value to read.
 * @returns The record, or an empty one.
 */
function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value === null || typeof value !== 'object'
    ? {}
    : (value as Readonly<Record<string, unknown>>);
}

/**
 * Reads a string, and an empty string from anything that is not one, so no
 * surface can render `"null"` or `"undefined"` as text.
 *
 * @param value Value to read.
 * @returns The string, or an empty string.
 */
function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Reads a charge budget, and `undefined` from anything that is not a finite
 * number, so a counter is rendered only where there is a count to render.
 *
 * @param value Value to read.
 * @returns The budget, or `undefined`.
 */
function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** What one render reads off a relic, each member already made total. */
interface RelicFields {
  readonly id: string;
  readonly name: string;
  readonly description: string;

  /** The tier, trimmed, and reported where it is outside the ladder. */
  readonly rarity: string;

  /** The bound hooks, in `HOOK_NAMES` order. */
  readonly hooks: readonly HookName[];

  /** The declaration's own budget, where it carries a finite one. */
  readonly declaredCharges: number | undefined;
}

/**
 * Reads every field a render needs off one relic, without widening the
 * seven-member declaration and without dereferencing a value that is not one.
 *
 * @param relic Relic to read.
 * @param reporter Contained sink.
 * @returns The fields, frozen.
 */
function readRelicFields(relic: Relic, reporter: UiReporter): RelicFields {
  const source = asRecord(relic);
  const id = readText(source['id']);

  return Object.freeze({
    id,
    name: readText(source['name']),
    description: readText(source['description']),
    rarity: readRarity(readText(source['rarity']), id, reporter),
    hooks: boundHooks(source['hooks']),
    declaredCharges: readCount(source['charges']),
  });
}

/**
 * The tier's accent under one palette, sampled off the shared ramp.
 *
 * @param rarity Tier to sample.
 * @param theme Palette to sample under, or `undefined` for the active one.
 * @param reporter Contained sink.
 * @returns The accent as 6-digit hex, or an empty string where the tier or the
 *   palette could not be resolved.
 */
function readRarityAccent(
  rarity: string,
  theme: ThemeId | undefined,
  reporter: UiReporter,
): string {
  if (!isKnownRarity(rarity)) {
    reporter.count(ACCENT_UNRESOLVED_METRIC, {
      context: REPORT_CONTEXT,
      reason: 'unknown-tier',
    });

    return '';
  }

  try {
    return resolveRarityColor(rarity, theme).colorHex;
  } catch (error: unknown) {
    reporter.error('rarity accent could not be resolved', error, {
      context: REPORT_CONTEXT,
      rarity,
      theme: theme ?? '',
    });
    reporter.count(ACCENT_UNRESOLVED_METRIC, {
      context: REPORT_CONTEXT,
      reason: 'resolve-threw',
    });

    return '';
  }
}

/**
 * Reads the effective reduced-motion value: the explicit override, then the
 * store, and otherwise motion permitted. The style layer carries the media
 * query itself, in style/_a11y.scss.
 *
 * @param options Options the factory received.
 * @param reporter Contained sink.
 * @returns Whether motion is to be reduced.
 */
function readReducedMotion(
  options: RelicCardSharedOptions,
  reporter: UiReporter,
): boolean {
  if (options.reducedMotion !== undefined) {
    return options.reducedMotion;
  }

  const store = options.preferences ?? null;

  if (store === null) {
    return false;
  }

  try {
    return store.isReducedMotion();
  } catch (error: unknown) {
    reporter.error('reduced-motion preference read threw', error, {
      context: REPORT_CONTEXT,
    });

    return false;
  }
}

/**
 * Subscribes to preference changes, where a store was supplied and no explicit
 * override stands in for it.
 *
 * @param options Options the factory received.
 * @param onChange Called after every preference change.
 * @param reporter Contained sink.
 * @returns The unsubscribe function, which is a no-op where nothing was
 *   subscribed. Calling it more than once is harmless.
 */
function subscribeMotion(
  options: RelicCardSharedOptions,
  onChange: () => void,
  reporter: UiReporter,
): () => void {
  const store = options.preferences ?? null;

  if (store === null || options.reducedMotion !== undefined) {
    return (): void => {
      return;
    };
  }

  let stop: (() => void) | null = null;

  try {
    stop = store.subscribe((): void => {
      onChange();
    });
  } catch (error: unknown) {
    reporter.error('preference subscribe threw', error, {
      context: REPORT_CONTEXT,
    });

    return (): void => {
      return;
    };
  }

  return (): void => {
    const release = stop;

    stop = null;

    if (release === null) {
      return;
    }

    try {
      release();
    } catch (error: unknown) {
      reporter.error('preference unsubscribe threw', error, {
        context: REPORT_CONTEXT,
      });
    }
  };
}

/**
 * Creates one element carrying a class and nothing else.
 *
 * @param doc Document the node is created in.
 * @param tag Element name.
 * @param className Class to carry.
 * @returns The element.
 */
function createElement(
  doc: Document,
  tag: string,
  className: string,
): HTMLElement {
  const element = doc.createElement(tag);

  element.className = className;

  return element;
}

/**
 * Creates one element carrying a class and text.
 *
 * Text is written with `textContent`, never as markup: a relic's description is
 * plain data.
 *
 * @param doc Document the node is created in.
 * @param tag Element name.
 * @param className Class to carry.
 * @param text Text to write.
 * @returns The element.
 */
function createTextElement(
  doc: Document,
  tag: string,
  className: string,
  text: string,
): HTMLElement {
  const element = createElement(doc, tag, className);

  element.textContent = text;

  return element;
}

/**
 * Creates one span that stays in the accessibility tree and out of the visual
 * one, through the visually-hidden utility of style/_a11y.scss.
 *
 * @param doc Document the node is created in.
 * @param text Text to write.
 * @returns The span.
 */
function createHiddenText(doc: Document, text: string): HTMLElement {
  return createTextElement(
    doc,
    'span',
    relicCardClasses.visuallyHidden,
    text,
  );
}

/**
 * Detaches an element from whatever holds it.
 *
 * @param element Element to detach, or `null`.
 */
function detach(element: Element | null): void {
  const parent = element === null ? null : element.parentNode;

  if (element !== null && parent !== null) {
    parent.removeChild(element);
  }
}

/**
 * Reads the charges a surface shows: the caller's value where it supplied one,
 * and the declaration's budget otherwise.
 *
 * `0` is a value, not an absence: it renders the exhausted state, while an
 * absent budget renders no counter at all.
 *
 * @param supplied Charges the caller tracked, or `undefined`.
 * @param declared Charges the declaration carries, or `undefined`.
 * @returns The charges to render, or `undefined` for none.
 */
function readCharges(
  supplied: number | undefined,
  declared: number | undefined,
): number | undefined {
  const tracked = readCount(supplied);

  return tracked === undefined ? declared : tracked;
}

/* ==========================================================================
 * 6. One relic, on any of the three surfaces
 * ========================================================================== */

/**
 * Renders one relic.
 *
 * The `reward` variant is a real `<button type="button">`, so Tab reaches it
 * and the focus ring style/_a11y.scss draws is carried without a rule of its
 * own; the `tray` and `summary` variants are list rows and take neither a
 * button nor a `tabindex`.
 *
 * Nothing is thrown: a variant with no document, or a host that does not
 * resolve, is reported and yields a component whose members are safe no-ops.
 *
 * @param options The relic, the surface, and the collaborators.
 * @returns The rendered card.
 *
 * @example
 * ```ts
 * // `panel` is the element the reward screen resolved and injected.
 * const card = createRelicCard({
 *   relic: offer[0],
 *   index: 0,
 *   host: panel,
 *   preferences,
 *   announcer,
 *   reporter,
 *   onSelect: (chosen) => { screen.choose(chosen); },
 * });
 * ```
 */
export function createRelicCard(options: RelicCardOptions): RelicCard {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const copy = resolveCopy(options.copy);
  const variant: RelicCardVariant = options.variant ?? 'reward';
  const interactive = variant === 'reward';
  const doc = resolveDocument(options);
  const host = resolveHost(
    {
      host: options.host,
      selector: options.hostSelector,
      name: CARD_MOUNT,
      root: doc,
    },
    reporter,
  );

  // One pair of ids per card: two cards on screen never name one element.
  const descriptionId = `${DESCRIPTION_ID_PREFIX}${idSequence}`;
  const hooksId = `${HOOKS_ID_PREFIX}${idSequence}`;

  idSequence += 1;

  let relic: Relic = options.relic;
  let charges = readCharges(
    options.charges,
    readRelicFields(options.relic, NOOP_UI_REPORTER).declaredCharges,
  );
  let slot = readCount(options.slot);
  let selected = options.selected === true;
  let disabled = options.disabled === true;
  let destroyed = false;

  /** Whether the activation for the key now held has already been served. */
  let keyActivation = false;

  const teardown: (() => void)[] = [];

  if (doc === null) {
    reporter.log('warn', 'relic card has no document to render into', {
      context: REPORT_CONTEXT,
      variant,
    });
    reporter.count(NO_DOCUMENT_METRIC, { context: REPORT_CONTEXT, variant });
  }

  /**
   * Creates the variant's root: the reward card's `<button>`, or the tray and
   * summary rows' `<li>`.
   */
  const createRoot = (owner: Document): HTMLElement => {
    if (interactive) {
      const button = owner.createElement('button');

      // The successor of the hrefless `<a>` controls at index.html L31, L38 and
      // L39: a real button is in the tab order and activates from Enter and
      // Space without a role, a `tabindex` or a rule of its own.
      button.type = 'button';
      button.className = relicCardClasses.card;

      return button;
    }

    return createElement(
      owner,
      'li',
      variant === 'tray'
        ? relicCardClasses.trayItem
        : relicCardClasses.summaryItem,
    );
  };

  const root: HTMLElement | null = doc === null ? null : createRoot(doc);

  /**
   * Appends one hidden separator between two adjacent runs of text, so the
   * flattened reading of the subtree keeps them as two words.
   */
  const appendSeparator = (owner: Document, parent: HTMLElement): void => {
    parent.append(createHiddenText(owner, copy.separator));
  };

  /** Writes an attribute, or removes it where the value is empty. */
  const reflectAttribute = (name: string, value: string): void => {
    if (root === null) {
      return;
    }

    if (value.length === 0) {
      root.removeAttribute(name);

      return;
    }

    root.setAttribute(name, value);
  };

  /** Builds the reward card's interior. */
  const renderReward = (
    owner: Document,
    element: HTMLElement,
    fields: RelicFields,
  ): void => {
    const header = createElement(owner, 'span', relicCardClasses.header);
    const index = readCount(options.index);

    if (index !== undefined) {
      const shortcut = createTextElement(
        owner,
        'span',
        relicCardClasses.shortcut,
        `${index + 1}`,
      );

      // Marked `aria-hidden`, so the digit is on screen and not in the
      // announcement.
      shortcut.setAttribute(HIDDEN_ATTRIBUTE, ARIA_TRUE);
      header.append(shortcut);
      appendSeparator(owner, header);
    }

    header.append(
      createTextElement(owner, 'span', relicCardClasses.name, fields.name),
    );

    const meta = createElement(owner, 'span', relicCardClasses.meta);

    meta.append(
      createTextElement(
        owner,
        'span',
        relicCardClasses.rarity,
        copy.rarity(fields.rarity),
      ),
    );

    if (charges !== undefined) {
      appendSeparator(owner, meta);
      meta.append(
        createTextElement(
          owner,
          'span',
          relicCardClasses.charges,
          copy.charges(charges),
        ),
      );

      if (charges === 0) {
        appendSeparator(owner, meta);
        meta.append(createHiddenText(owner, copy.exhausted));
      }
    }

    const description = createTextElement(
      owner,
      'span',
      relicCardClasses.description,
      fields.description,
    );

    description.id = descriptionId;
    element.append(header);
    appendSeparator(owner, element);
    element.append(meta);
    appendSeparator(owner, element);
    element.append(description);

    if (fields.hooks.length === 0) {
      reflectAttribute(DESCRIBED_BY_ATTRIBUTE, descriptionId);

      return;
    }

    const badges = createElement(owner, 'span', relicCardClasses.hooks);

    badges.id = hooksId;

    // The row carries its name in text, beside the badges.
    badges.append(createHiddenText(owner, copy.hooksLabel));

    for (const hook of fields.hooks) {
      appendSeparator(owner, badges);
      badges.append(
        createTextElement(owner, 'span', relicCardClasses.hookBadge, hook),
      );
    }

    appendSeparator(owner, element);
    element.append(badges);
    reflectAttribute(DESCRIBED_BY_ATTRIBUTE, `${descriptionId} ${hooksId}`);
  };

  /** Builds the tray row's interior. */
  const renderTray = (
    owner: Document,
    element: HTMLElement,
    fields: RelicFields,
  ): void => {
    const control = createElement(
      owner,
      'span',
      relicCardClasses.trayControl,
    );

    // The slot number on screen is the CSS counter style/_hud.scss increments;
    // generated content stays out of the accessibility tree, and the pickup
    // position is stated here in text as well.
    if (slot !== undefined) {
      control.append(createHiddenText(owner, copy.slot(slot)));
      appendSeparator(owner, control);
    }

    const name = createTextElement(
      owner,
      'span',
      relicCardClasses.trayName,
      fields.name,
    );

    // The whole name, on an element the stylesheet truncates to an ellipsis.
    name.title = fields.name;
    control.append(name);

    if (fields.rarity.length > 0) {
      appendSeparator(owner, control);
      control.append(
        createHiddenText(owner, copy.rarityText(fields.rarity)),
      );
    }

    if (charges !== undefined) {
      appendSeparator(owner, control);
      control.append(
        createTextElement(
          owner,
          'span',
          relicCardClasses.trayCharges,
          copy.chargesRemaining(charges),
        ),
      );

      if (charges === 0) {
        appendSeparator(owner, control);
        control.append(createHiddenText(owner, copy.exhausted));
      }
    }

    element.append(control);
  };

  /** Builds the summary row's interior. */
  const renderSummary = (
    owner: Document,
    element: HTMLElement,
    fields: RelicFields,
  ): void => {
    const row = createElement(owner, 'div', relicCardClasses.summaryRow);

    if (slot !== undefined) {
      row.append(createHiddenText(owner, copy.slot(slot)));
      appendSeparator(owner, row);
    }

    row.append(
      createTextElement(
        owner,
        'span',
        relicCardClasses.summaryName,
        fields.name,
      ),
    );
    appendSeparator(owner, row);
    row.append(
      createTextElement(
        owner,
        'span',
        relicCardClasses.summaryRarity,
        copy.rarity(fields.rarity),
      ),
    );

    if (charges !== undefined) {
      appendSeparator(owner, row);
      row.append(
        createTextElement(
          owner,
          'span',
          relicCardClasses.summaryCharges,
          copy.chargesRemaining(charges),
        ),
      );

      if (charges === 0) {
        appendSeparator(owner, row);
        row.append(createHiddenText(owner, copy.exhausted));
      }
    }

    element.append(row);
  };

  /** Reflects the chosen state, which style/_reward.scss dresses. */
  const reflectSelected = (): void => {
    if (!interactive) {
      return;
    }

    reflectAttribute(PRESSED_ATTRIBUTE, selected ? ARIA_TRUE : '');
  };

  /**
   * Reflects the refused state on `aria-disabled`, which leaves the card
   * focusable and announceable.
   */
  const reflectDisabled = (): void => {
    if (!interactive) {
      return;
    }

    reflectAttribute(DISABLED_ATTRIBUTE, disabled ? ARIA_TRUE : '');
  };

  /**
   * Applies or withholds the entrance marker, beside the `motion-allowed` gate
   * style/_reward.scss carries on the `pop` animation of style/main.scss
   * L434-L452.
   */
  const reflectEntrance = (): void => {
    if (root === null || !interactive) {
      return;
    }

    if (readReducedMotion(options, reporter)) {
      root.classList.remove(relicCardClasses.entrance);

      return;
    }

    root.classList.add(relicCardClasses.entrance);
  };

  /** Rebuilds the interior and restates every attribute. */
  const render = (): void => {
    if (root === null || doc === null) {
      return;
    }

    const fields = readRelicFields(relic, reporter);

    root.replaceChildren();
    reflectAttribute(relicCardAttributes.relicId, fields.id);
    reflectAttribute(relicCardAttributes.rarity, fields.rarity);

    if (interactive) {
      const index = readCount(options.index);

      reflectAttribute(
        relicCardAttributes.offerIndex,
        index === undefined ? '' : `${index}`,
      );

      // The name carries the relic and its tier; the description and the badge
      // row are associated by reference from `renderReward`.
      reflectAttribute(
        LABEL_ATTRIBUTE,
        copy.accessibleName(
          fields.name,
          copy.rarity(fields.rarity),
          charges === undefined ? '' : copy.charges(charges),
        ),
      );
      renderReward(doc, root, fields);
    } else {
      reflectAttribute(
        relicCardAttributes.charges,
        charges === undefined ? '' : `${charges}`,
      );

      if (variant === 'tray') {
        renderTray(doc, root, fields);
      } else {
        renderSummary(doc, root, fields);
      }
    }

    reflectSelected();
    reflectDisabled();
    reporter.count(CARD_RENDERED_METRIC, {
      context: REPORT_CONTEXT,
      variant,
      relicId: fields.id,
      rarity: fields.rarity,
      hooks: fields.hooks.length,
      charges: charges === undefined ? -1 : charges,
    });
  };

  /** Announces the acquisition, in primitives, where a region was supplied. */
  const announce = (fields: RelicFields): void => {
    const announcer = options.announcer ?? null;

    if (announcer === null) {
      return;
    }

    try {
      announcer.announce(
        charges === undefined
          ? {
              kind: 'relicAcquired',
              name: fields.name,
              rarity: fields.rarity,
            }
          : {
              kind: 'relicAcquired',
              name: fields.name,
              rarity: fields.rarity,
              charges,
            },
      );
    } catch (error: unknown) {
      reporter.error('relic acquisition announcement threw', error, {
        context: REPORT_CONTEXT,
        relicId: fields.id,
      });
    }
  };

  /**
   * Reports one activation out through `onSelect` and announces it.
   *
   * The whole of what an activation does: no input action is emitted here, and
   * the relic is handed over unchanged.
   */
  const activate = (source: string): void => {
    if (destroyed) {
      reporter.count(AFTER_DESTROY_METRIC, {
        context: REPORT_CONTEXT,
        member: 'activate',
      });

      return;
    }

    if (disabled) {
      reporter.count(CARD_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        reason: 'disabled',
        source,
      });

      return;
    }

    const select = options.onSelect;
    const fields = readRelicFields(relic, reporter);

    if (select === undefined) {
      reporter.count(CARD_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        reason: 'no-handler',
        source,
      });

      return;
    }

    reporter.count(CARD_SELECTED_METRIC, {
      context: REPORT_CONTEXT,
      relicId: fields.id,
      source,
    });

    try {
      select(relic);
      announce(fields);
    } catch (error: unknown) {
      reporter.error('relic selection handler threw', error, {
        context: REPORT_CONTEXT,
        relicId: fields.id,
        source,
      });
    }
  };

  if (interactive && root !== null) {
    const element = root;

    /** Pointer activation, and the click a key press was already served for. */
    const onClick = (): void => {
      if (keyActivation) {
        keyActivation = false;

        return;
      }

      activate('pointer');
    };

    /**
     * Keyboard activation. `preventDefault` stops the page scrolling on Space
     * and stops the activation behaviour that would synthesise a click; the
     * guard skips a click that arrives after a key press was served.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = readText(event.key);

      if (!ACTIVATION_KEYS.has(key)) {
        return;
      }

      event.preventDefault();
      keyActivation = true;
      activate('keyboard');
    };

    const onKeyUp = (): void => {
      keyActivation = false;
    };

    element.addEventListener('click', onClick);
    element.addEventListener('keydown', onKeyDown);
    element.addEventListener('keyup', onKeyUp);
    teardown.push((): void => {
      element.removeEventListener('click', onClick);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('keyup', onKeyUp);
    });
  }

  const releaseMotion = subscribeMotion(
    options,
    (): void => {
      if (!destroyed) {
        reflectEntrance();
      }
    },
    reporter,
  );

  render();
  reflectEntrance();

  if (host !== null && root !== null) {
    host.append(root);
  }

  return Object.freeze({
    element: root,
    variant,

    relic: (): Relic => relic,

    update: (next: Relic, nextCharges?: number, nextSlot?: number): void => {
      if (destroyed) {
        reporter.count(AFTER_DESTROY_METRIC, {
          context: REPORT_CONTEXT,
          member: 'update',
        });

        return;
      }

      relic = next;
      charges = readCharges(
        nextCharges,
        readRelicFields(next, NOOP_UI_REPORTER).declaredCharges,
      );

      if (nextSlot !== undefined) {
        slot = readCount(nextSlot);
      }

      render();
    },

    setSelected: (next: boolean): void => {
      if (destroyed) {
        reporter.count(AFTER_DESTROY_METRIC, {
          context: REPORT_CONTEXT,
          member: 'setSelected',
        });

        return;
      }

      selected = next === true;
      reflectSelected();
    },

    setDisabled: (next: boolean): void => {
      if (destroyed) {
        reporter.count(AFTER_DESTROY_METRIC, {
          context: REPORT_CONTEXT,
          member: 'setDisabled',
        });

        return;
      }

      disabled = next === true;
      reflectDisabled();
    },

    focus: (): boolean => {
      if (destroyed || root === null || doc === null) {
        reporter.count(AFTER_DESTROY_METRIC, {
          context: REPORT_CONTEXT,
          member: 'focus',
        });

        return false;
      }

      try {
        root.focus();
      } catch (error: unknown) {
        reporter.error('relic card could not take focus', error, {
          context: REPORT_CONTEXT,
          variant,
        });

        return false;
      }

      return doc.activeElement === root;
    },

    rarityAccent: (): string =>
      readRarityAccent(
        readRelicFields(relic, NOOP_UI_REPORTER).rarity,
        options.theme,
        reporter,
      ),

    destroy: (): void => {
      if (destroyed) {
        reporter.count(AFTER_DESTROY_METRIC, {
          context: REPORT_CONTEXT,
          member: 'destroy',
        });

        return;
      }

      destroyed = true;
      releaseMotion();

      for (const undo of teardown.splice(0)) {
        try {
          undo();
        } catch (error: unknown) {
          reporter.error('relic card listener removal threw', error, {
            context: REPORT_CONTEXT,
            variant,
          });
        }
      }

      detach(root);
      root?.replaceChildren();
      reporter.count(DESTROYED_METRIC, { context: REPORT_CONTEXT, variant });
    },
  });
}

/* ==========================================================================
 * 7. The drawn offer
 * ========================================================================== */

/** Role restated on the list, which `list-style: none` removes in engines. */
const LIST_ROLE = 'list';

/**
 * Renders the drawn offer as `ul.reward-offers`, one `li.reward-offer` per
 * relic holding one reward card.
 *
 * ORDER IS THE ORDER SUPPLIED — the order src/relics/relic-draw.ts sampled the
 * offer in. Nothing here sorts, groups or reverses it, and style/_reward.scss
 * declares no `order`, no reversed direction and no dense placement, so
 * document order is what renders.
 *
 * @param options The offer and the collaborators.
 * @returns The rendered list.
 *
 * @example
 * ```ts
 * const grid = createRelicCardGrid({
 *   relics: offer,
 *   host: panel,
 *   reporter,
 *   onSelect: (relic) => { screen.choose(relic); },
 * });
 *
 * grid.focusFirst();
 * ```
 */
export function createRelicCardGrid(
  options: RelicCardGridOptions,
): RelicCardGrid {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const doc = resolveDocument(options);
  const host = resolveHost(
    {
      host: options.host,
      selector: options.hostSelector ?? RELIC_CARD_GRID_HOST_SELECTOR,
      name: GRID_MOUNT,
      root: doc,
    },
    reporter,
  );

  if (doc === null) {
    reporter.log('warn', 'relic card grid has no document to render into', {
      context: REPORT_CONTEXT,
      mount: GRID_MOUNT,
    });
    reporter.count(NO_DOCUMENT_METRIC, {
      context: REPORT_CONTEXT,
      mount: GRID_MOUNT,
    });
  }

  const list: HTMLElement | null =
    doc === null ? null : createElement(doc, 'ul', relicCardClasses.offers);

  if (list !== null) {
    list.setAttribute('role', LIST_ROLE);
  }

  let offers: readonly Relic[] = Object.freeze([...(options.relics ?? [])]);
  let cards: RelicCard[] = [];
  let destroyed = false;

  /** Builds one card's options, carrying every collaborator downward. */
  const cardOptionsFor = (
    relic: Relic,
    index: number,
    item: Element,
  ): RelicCardOptions => ({
    relic,
    variant: 'reward',
    index,
    host: item,
    document: doc,
    reporter: options.reporter,
    announcer: options.announcer,
    preferences: options.preferences,
    reducedMotion: options.reducedMotion,
    theme: options.theme,
    copy: options.copy,
    onSelect: options.onSelect,
  });

  /** Destroys every card and empties the list. */
  const clear = (): void => {
    for (const card of cards.splice(0)) {
      card.destroy();
    }

    list?.replaceChildren();
  };

  /** Rebuilds the list, in the order the offer was supplied. */
  const render = (): void => {
    if (list === null || doc === null) {
      return;
    }

    clear();

    const built: RelicCard[] = [];
    let index = 0;

    for (const relic of offers) {
      const item = createElement(doc, 'li', relicCardClasses.offer);

      built.push(createRelicCard(cardOptionsFor(relic, index, item)));
      list.append(item);
      index += 1;
    }

    cards = built;
    reporter.count(GRID_RENDERED_METRIC, {
      context: REPORT_CONTEXT,
      offers: offers.length,
    });
  };

  render();

  if (host !== null && list !== null) {
    host.append(list);
  }

  return Object.freeze({
    element: list,

    cards: (): readonly RelicCard[] => Object.freeze([...cards]),

    relics: (): readonly Relic[] => offers,

    update: (next: readonly Relic[]): void => {
      if (destroyed) {
        reporter.count(AFTER_DESTROY_METRIC, {
          context: REPORT_CONTEXT,
          mount: GRID_MOUNT,
          member: 'update',
        });

        return;
      }

      offers = Object.freeze([...next]);
      render();
    },

    focusFirst: (): boolean => {
      if (destroyed || list === null || doc === null) {
        reporter.count(AFTER_DESTROY_METRIC, {
          context: REPORT_CONTEXT,
          mount: GRID_MOUNT,
          member: 'focusFirst',
        });

        return false;
      }

      // The list's own focusable children, enumerated in DOM order. The trap
      // that contains focus while the screen is up is the reward screen's, from
      // `trap()` of src/ui/a11y/focus-manager.ts, and is not duplicated here.
      const focusable = collectFocusable(list, {
        reporter: options.reporter ?? NOOP_UI_REPORTER,
        context: REPORT_CONTEXT,
      });
      const first = focusable.at(0);

      if (first === undefined) {
        reporter.count(GRID_FOCUS_METRIC, {
          context: REPORT_CONTEXT,
          focused: false,
          reason: 'no-focusable',
        });

        return false;
      }

      try {
        first.focus();
      } catch (error: unknown) {
        reporter.error('reward offer could not take focus', error, {
          context: REPORT_CONTEXT,
        });

        return false;
      }

      const taken = doc.activeElement === first;

      reporter.count(GRID_FOCUS_METRIC, {
        context: REPORT_CONTEXT,
        focused: taken,
      });

      return taken;
    },

    destroy: (): void => {
      if (destroyed) {
        reporter.count(AFTER_DESTROY_METRIC, {
          context: REPORT_CONTEXT,
          mount: GRID_MOUNT,
          member: 'destroy',
        });

        return;
      }

      destroyed = true;
      clear();
      detach(list);
      offers = Object.freeze([]);
      reporter.count(GRID_DESTROYED_METRIC, { context: REPORT_CONTEXT });
    },
  });
}

/* ==========================================================================
 * 8. One held relic, on the tray
 * ========================================================================== */

/**
 * The declaration a tray row falls back to where the held record carries none.
 *
 * Frozen, and never handed to a caller: `relic()` returns what was supplied.
 * Its tier is the ladder's first, which is the ramp's low anchor.
 */
const EMPTY_RELIC: Relic = Object.freeze({
  id: '',
  name: '',
  rarity: RARITIES[0],
  description: '',
  hooks: Object.freeze({}),
});

/**
 * The one-based slot a held relic occupies, from the zero-based `pickupOrder`
 * src/relics/relic-registry.ts assigned at pickup and never reassigns.
 *
 * @param relic Held relic to read.
 * @returns The slot, or `undefined` where the record carries no order.
 */
function readSlot(relic: ActiveRelic): number | undefined {
  const order = readCount(asRecord(relic)['pickupOrder']);

  return order === undefined ? undefined : order + 1;
}

/**
 * Reads the charges a held relic has left, as the registry holds them.
 *
 * @param relic Held relic to read.
 * @returns The count, or `undefined` where the relic carries no budget.
 */
function readHeldCharges(relic: ActiveRelic): number | undefined {
  return readCount(asRecord(relic)['charges']);
}

/**
 * Reads a held relic's declaration, tolerating a record that carries none.
 *
 * @param relic Held relic to read.
 * @returns The declaration, or `EMPTY_RELIC` where the record carries none.
 */
function readDefinition(relic: ActiveRelic): Relic {
  const definition = asRecord(relic)['definition'];

  return definition === null || typeof definition !== 'object'
    ? EMPTY_RELIC
    : (definition as Relic);
}

/**
 * Renders one held relic as `li.relic-tray-item`.
 *
 * The row is NOT interactive: it is a list row with no button and no
 * `tabindex`, and src/input/on-screen-controls.ts owns every element-to-action
 * binding. Its slot is the `pickupOrder` src/relics/relic-registry.ts assigned,
 * rendered as text as well as by the CSS counter style/_hud.scss increments,
 * and its count is the budget the registry holds — neither is recomputed here.
 *
 * @param options The held relic and the collaborators.
 * @returns The rendered row.
 *
 * @example
 * ```ts
 * // `registry.active()` is pickup-ordered and is iterated as it stands.
 * const rows = registry
 *   .active()
 *   .map((held) => createRelicTrayItem({ relic: held, host: tray, reporter }));
 * ```
 */
export function createRelicTrayItem(
  options: RelicTrayItemOptions,
): RelicTrayItem {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const slot = readSlot(options.relic);

  let held: ActiveRelic = options.relic;
  let destroyed = false;

  const card = createRelicCard({
    relic: readDefinition(options.relic),
    variant: 'tray',
    charges: readHeldCharges(options.relic),
    slot,
    host: options.host,
    hostSelector: options.hostSelector ?? RELIC_TRAY_HOST_SELECTOR,
    document: options.document,
    reporter: options.reporter,
    announcer: options.announcer,
    preferences: options.preferences,
    reducedMotion: options.reducedMotion,
    theme: options.theme,
    copy: options.copy,
  });

  reporter.count(TRAY_RENDERED_METRIC, {
    context: REPORT_CONTEXT,
    mount: TRAY_MOUNT,
    slot: slot ?? -1,
  });

  return Object.freeze({
    element: card.element,

    relic: (): ActiveRelic => held,

    update: (next: ActiveRelic): void => {
      if (destroyed) {
        reporter.count(AFTER_DESTROY_METRIC, {
          context: REPORT_CONTEXT,
          mount: TRAY_MOUNT,
          member: 'update',
        });

        return;
      }

      const nextSlot = readSlot(next);

      held = next;
      card.update(readDefinition(next), readHeldCharges(next), nextSlot);
      reporter.count(TRAY_RENDERED_METRIC, {
        context: REPORT_CONTEXT,
        mount: TRAY_MOUNT,
        slot: nextSlot ?? -1,
      });
    },

    rarityAccent: (): string => card.rarityAccent(),

    destroy: (): void => {
      if (destroyed) {
        reporter.count(AFTER_DESTROY_METRIC, {
          context: REPORT_CONTEXT,
          mount: TRAY_MOUNT,
          member: 'destroy',
        });

        return;
      }

      destroyed = true;
      card.destroy();
      reporter.count(TRAY_DESTROYED_METRIC, { context: REPORT_CONTEXT });
    },
  });
}
