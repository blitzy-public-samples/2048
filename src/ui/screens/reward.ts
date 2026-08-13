// The reward screen: the choose-one-of-three relic offer, rendered for the
// router state `reward`.
//
// WHAT ARRIVES AND FROM WHERE
//   The offer is DRAWN ELSEWHERE and handed to this module. It arrives on the
//   `reward` screen context of ../screen-router as `drawn` (relics) and
//   `offers` (the same offer as plain card data), both in draw order.
//   src/relics/relic-draw.ts is sampled once per cleared stage by
//   ../../run/run-controller.ts; this module neither imports it nor calls it,
//   and no member here samples, shuffles, re-orders or re-requests an offer.
//
// WHAT LEAVES AND TO WHERE
//   A card activation publishes the `selectReward` action of ../../input/keymap
//   carrying the activated card's ZERO-BASED OFFER INDEX, which is the payload
//   type that action declares. The relic identifier is handed to the injected
//   `onSelect` callback beside it. Applying the choice belongs to
//   `RunController.resolveReward` and assigning pickup order belongs to
//   `RelicRegistry.pickUp`: neither is called here, no run state is written
//   here and no stage is advanced here.
//
// WHAT IT OWNS
//   the `.reward-panel` chrome — heading and hint — inside the container
//   index.html declares at `#screen-reward`;
//   the offer list, through `createRelicCardGrid` of ../components/relic-card;
//   the focus trap over that container while the offer stands;
//   the once-per-offer selection guard;
//   nothing else. It resolves no rule, holds no engine reference, writes no
//   `hidden` attribute and touches no input context — ../screen-router owns
//   the container's shown state and the input manager's `setContext`/`suspend`.
//
// SINGLE-OWNER CONTRACT
//   This module takes ownership of its container's children, so a composition
//   that registers it as the router's `reward` screen must not also drive
//   `ScreenRouter.showReward` for the same container. A list already rendered
//   into the container by another surface is reported and replaced rather than
//   stacked, and a trap already engaged on the container is adopted rather
//   than stacked.
//
// PROVENANCE OF THE GUARDED LOOKUPS
//   js/html_actuator.js L2-L5 performed four `document.querySelector` calls
//   and null-checked none of them, so a renamed class was a startup failure
//   (I12). Every lookup here goes through `resolveMount` of ../a11y/settings
//   and every miss is reported. The tile layer that was one of those four no
//   longer exists, and no selector of it appears anywhere in this module.
//
// Rows of docs/TRACEABILITY_MATRIX.md. Every row is TARGET-ONLY: the reward
// screen has NO vanilla source construct — the pre-migration product had one
// screen, no router, no relic and no offer — so the reverse direction of the
// matrix maps none of these to a `js/` construct, and that absence is declared
// rather than left as a gap:
//   TR-REWARDSCREEN-01  target-only row  `createRewardScreen()` and the
//                                        `Screen` lifecycle it implements
//   TR-REWARDSCREEN-02  target-only row  the panel chrome and the offer list
//                                        hosted inside it
//   TR-REWARDSCREEN-03  target-only row  the `selectReward` publication and
//                                        the once-per-offer selection guard
//   TR-REWARDSCREEN-04  target-only row  the focus trap, its adoption and its
//                                        release on every exit path
//   TR-REWARDSCREEN-05  target-only row  the three-tier offer resolution and
//                                        the view-only projection
//
// Decisions behind this file, argued in docs/DECISION_LOG.md and named here
// only so the construct can be found from the log:
//   DL-REWARD-05  the offer arriving on the context, never drawn here
//   DL-REWARD-06  `selectReward` carrying the offer index rather than the
//                 relic identifier
//   DL-REWARD-07  the acquisition announced by this screen, with the card
//                 component constructed with no live region of its own
//   DL-REWARD-08  the trap released on every exit path, with `release()`
//                 treated as idempotent rather than guarded by a flag
//   DL-REWARD-09  the three-tier offer resolution and the view-only projection
//   DL-REWARD-10  a duplicate offer reported rather than de-duplicated
//   DL-REWARD-11  sole ownership of the container's children, a foreign list
//                 reported rather than resolved, and a standing trap adopted

import type {
  RewardCard,
  Screen,
  ScreenContext,
  RewardScreenContext,
} from '../screen-router';
import {
  DEFAULT_REWARD_COPY,
  SCREEN_ANNOUNCEMENTS,
  SCREEN_MOUNTS,
} from '../screen-router';
import type { PreferenceStore, UiReporter } from '../a11y/settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from '../a11y/settings';
import type { LiveRegionAnnouncer } from '../a11y/live-region';
import type { FocusManager, FocusTrapHandle } from '../a11y/focus-manager';
import { trap } from '../a11y/focus-manager';
import type {
  RelicCard,
  RelicCardCopy,
  RelicCardGrid,
} from '../components/relic-card';
import {
  createRelicCardGrid,
  relicCardClasses,
} from '../components/relic-card';
import type { Relic, Rarity } from '../../relics/relic-types';
import type { HookHandlerTable, HookName } from '../../engine/hooks';
import { HOOK_NAMES } from '../../engine/hooks';
import type { InputEventName } from '../../input/keymap';
import type { InputEmitter } from '../../input/input-manager';
import { motion, zIndex } from '../../theme/tokens';
import type { RarityTier, ThemeId } from '../../theme/themes';
import { rarityTiers, resolveRarityColor } from '../../theme/themes';

/**
 * Container this screen renders into, as index.html L99 declares it and as
 * `SCREEN_MOUNTS` of ../screen-router routes it.
 */
export const REWARD_SCREEN_MOUNT_SELECTOR: string = SCREEN_MOUNTS.reward;

/** Every class this module applies. */
export const rewardScreenClasses = Object.freeze({
  /** The dialog surface holding the heading, the hint and the list. */
  panel: 'reward-panel',

  /** The offer's heading. */
  heading: 'reward-heading',

  /** The line under the heading. */
  hint: 'reward-hint',

  /** The list ../components/relic-card creates, named here for detection. */
  offers: relicCardClasses.offers,
});

/**
 * Paint rung this surface occupies: the modal slot of the shared ladder, read
 * from ../../theme/tokens.
 *
 * style/_reward.scss declares the value on `.screen[data-screen="reward"]`;
 * this module writes no `z-index` and states the rung so a consumer can assert
 * on it. It is the highest rung a screen occupies — the diagnostics overlay
 * sits above it at `zIndex.diagnosticsOverlay` and must stay visible.
 */
export const REWARD_SCREEN_LAYER: number = zIndex.modal;

/**
 * Entrance the cards carry, read from the `pop` vocabulary of
 * ../../theme/tokens.
 *
 * The keyframes are declared at style/main.scss L756-L768 and bound to
 * `.reward-offer .relic-card` inside style/_reward.scss's `motion-allowed`
 * block, so the stylesheet performs the animation and its suppression. No
 * duration, delay, easing or overshoot is restated here.
 */
export const REWARD_SCREEN_ENTRANCE = Object.freeze({
  duration: motion.pop.duration,
  delay: motion.pop.delay,
  easing: motion.pop.easing,
  fillMode: motion.pop.fillMode,
  overshoot: motion.pop.keyframes.mid.scale,
});

/**
 * Offers one reward presents, per AAP R8 and §0.6.4 — the choice is one of
 * three.
 */
export const EXPECTED_OFFER_COUNT = 3;

/** Label naming this module in every report. */
const REPORT_CONTEXT = 'reward-screen';

/** Logical name the container is reported under. */
const HOST_MOUNT = 'rewardScreen';

/** The `role` index.html declares on the container. */
const DIALOG_ROLE = 'dialog';

/** Attribute marking the container modal. */
const MODAL_ATTRIBUTE = 'aria-modal';

/** Attribute naming the container. */
const LABEL_ATTRIBUTE = 'aria-label';

/** Attribute holding the `role` this module verifies. */
const ROLE_ATTRIBUTE = 'role';

/** Attribute the panel points at its heading with. */
const LABELLED_BY_ATTRIBUTE = 'aria-labelledby';

/** Identifier stem the heading is addressed by. */
const HEADING_ID_PREFIX = 'reward-heading-';

/** The action a card activation publishes. */
const SELECT_REWARD_ACTION = 'selectReward' satisfies InputEventName;

/** Counter raised once per offer rendered. */
const RENDERED_METRIC = 'ui.rewardScreen.rendered';

/** Counter raised once per refresh that presented the standing offer again. */
const REFRESH_METRIC = 'ui.rewardScreen.refreshed';

/** Counter raised once per selection this screen published. */
const SELECTED_METRIC = 'ui.rewardScreen.selected';

/** Counter raised for an activation the selection guard refused. */
const SELECT_REFUSED_METRIC = 'ui.rewardScreen.selectRefused';

/** Counter raised where the container did not resolve. */
const NO_HOST_METRIC = 'ui.rewardScreen.hostMissing';

/** Counter raised where no document was available to render into. */
const NO_DOCUMENT_METRIC = 'ui.rewardScreen.documentMissing';

/** Counter raised where the offer handed over was empty. */
const EMPTY_OFFER_METRIC = 'ui.rewardScreen.offerEmpty';

/** Counter raised where the offer did not hold `EXPECTED_OFFER_COUNT`. */
const OFFER_COUNT_METRIC = 'ui.rewardScreen.offerCountUnexpected';

/** Counter raised where one offer held the same relic twice. */
const DUPLICATE_OFFER_METRIC = 'ui.rewardScreen.offerDuplicate';

const PROJECTED_OFFER_METRIC = 'ui.rewardScreen.offerProjected';

/** Counter raised where another surface had already rendered a list. */
const FOREIGN_SURFACE_METRIC = 'ui.rewardScreen.foreignSurface';

/** Counter raised where the trap refused to engage. */
const TRAP_REFUSED_METRIC = 'ui.rewardScreen.trapRefused';

/** Counter raised where an already-engaged trap was adopted. */
const TRAP_ADOPTED_METRIC = 'ui.rewardScreen.trapAdopted';

/** Counter raised where initial focus could not be placed. */
const FOCUS_REFUSED_METRIC = 'ui.rewardScreen.focusRefused';

/** Counter raised where a lifecycle member ran after `unmount`. */
const AFTER_UNMOUNT_METRIC = 'ui.rewardScreen.afterUnmount';

/** Counter raised where a context for another state was handed over. */
const WRONG_CONTEXT_METRIC = 'ui.rewardScreen.contextMismatch';

/** Counter raised for each accessibility attribute this module supplied. */
const SEMANTICS_SUPPLIED_METRIC = 'ui.rewardScreen.semanticsSupplied';

/** Counter raised where a rarity accent could not be sampled. */
const ACCENT_UNRESOLVED_METRIC = 'ui.rewardScreen.rarityAccentUnresolved';

/** The prose this screen renders. */
export interface RewardScreenCopy {
  /** The offer's heading, which also names the dialog. */
  readonly heading: string;

  /** The line under the heading. */
  readonly hint: string;

  /** The line announced on entering the state. */
  readonly announcement: string;
}

/**
 * The copy in force where a caller overrides none of it.
 *
 * The heading and the hint are `DEFAULT_REWARD_COPY` of ../screen-router and
 * the announcement is `SCREEN_ANNOUNCEMENTS.reward`, so the three strings have
 * one declaration between the router's own surface and this screen.
 */
export const defaultRewardScreenCopy: RewardScreenCopy = Object.freeze({
  heading: DEFAULT_REWARD_COPY.heading,
  hint: DEFAULT_REWARD_COPY.hint,
  announcement: SCREEN_ANNOUNCEMENTS.reward,
});

/** Everything `createRewardScreen` accepts. All members are optional. */
export interface RewardScreenOptions {
  /**
   * Document the panel is created in. Defaults to the container's own
   * document, and then to the ambient one; outside a browser, and with neither
   * available, nothing is created and the absence is reported.
   */
  readonly document?: Document | null;

  /**
   * Container this screen renders into, already resolved. `null` marks a
   * container the caller looked for and did not find, which is reported.
   *
   * /screen-router injects it through `mount`, which supersedes this.
   */
  readonly host?: Element | null;

  /**
   * Selector the container is resolved at through `resolveMount` where neither
   * `mount` nor `host` supplied one. Defaults to
   * `REWARD_SCREEN_MOUNT_SELECTOR`; index.html is the authority for it.
   */
  readonly hostSelector?: string;

  /** Sink every miss, refusal and degradation is reported through. */
  readonly reporter?: UiReporter;

  /**
   * Region the state and the selection are announced through. Absent, both
   * announcements are skipped and nothing is written to a console instead.
   *
   * A composition whose reward transaction announces the acquisition supplies
   * none, so one accepted selection produces one line however it was chosen.
   * DL-REWARD-14.
   */
  readonly announcer?: LiveRegionAnnouncer | null;

  /**
   * Store the effective reduced-motion value is read from and handed to each
   * card, so the entrance marker follows the preference in force.
   */
  readonly preferences?: PreferenceStore | null;

  /**
   * Reduced-motion value overriding both the store and the media query. `true`
   * withholds the entrance marker; the cards still render at full size, since
   * style/_reward.scss declares the entrance only inside its `motion-allowed`
   * block.
   */
  readonly reducedMotion?: boolean;

  /** Palette the rarity accents are sampled under. Defaults to the active. */
  readonly theme?: ThemeId;

  /**
   * Focus manager the trap is engaged through, so this screen shares one trap
   * stack with the rest of the page. Absent, the standalone `trap` of
   * ../a11y/focus-manager is used, which owns a stack of its own.
   *
   * Where the manager already holds a trap on this screen's container, that
   * trap is ADOPTED and no second one is engaged.
   */
  readonly focus?: FocusManager | null;

  /**
   * Emitter a card activation publishes `selectReward` on. Absent, nothing is
   * published and `onSelect` is still called, so a caller can drive the screen
   * without an input manager.
   */
  readonly input?: InputEmitter | null;

  /**
   * Called with the chosen relic's identifier and its zero-based offer index,
   * and REPORTS BACK whether the transaction accepted the choice.
   *
   * Applying a choice belongs to `RunController.resolveReward`; this screen
   * only reports the press and reads the answer. `false` leaves the offer
   * standing, every card live and nothing announced, so a refused choice can be
   * made again. A handler answering nothing is read as acceptance. Decision
   * DL-REWARD-12.
   */
  readonly onSelect?: (relicId: string, index: number) => boolean | void;

  /**
   * Whether this screen engages a focus trap of its own. Defaults to `true`.
   *
   * `false` is for a composition whose router owns every screen trap: the trap
   * is engaged over this same container by that owner, and this screen neither
   * engages nor adopts one. Decision DL-REWARD-12.
   */
  readonly trapFocus?: boolean;

  /**
   * Whether this screen places initial focus and announces on entry. Defaults
   * to `true`.
   *
   * `false` is for a composition whose router places focus and reads the entry
   * line, which `announcement()` below composes. The acquisition announcement
   * is left on either way: it reports the transaction, not the entry. Decision
   * DL-REWARD-12.
   */
  readonly announceEntry?: boolean;

  /**
   * Called when Escape is pressed while this screen's own trap holds focus.
   * ../../input/keymap owns the `cancel` vocabulary and ../screen-router
   * decides what the key means, so nothing is published from here.
   */
  readonly onEscape?: () => void;

  /**
   * Resolves where focus returns to when the trap releases.
   *
   * A FUNCTION, not an element, and called once per engage: the parallel board
   * layer uses a roving tab stop, so the element that can take focus is
   * whichever cell currently carries it. Returning `null` leaves the trap's
   * own fallback in charge, which restores to whatever held focus before.
   */
  readonly restoreFocusTo?: () => Element | null;

  /**
   * Containers made inert for the trap's lifetime, so a screen reader's
   * virtual cursor cannot leave the dialog. Passed through untouched; nothing
   * is inferred by walking the document.
   */
  readonly inertBackground?: readonly (Element | null | undefined)[];

  /**
   * Resolves an offer identifier to the relic it names.
   *
   * Consulted only where the context carried plain card data and no relic —
   * the catalogue lives in src/relics, which this module does not import, so
   * the composition that owns it supplies the resolver. Returning `null` falls
   * through to the view-only projection.
   */
  readonly resolveRelic?: (relicId: string) => Relic | null;

  /** Overrides for any subset of this screen's prose. */
  readonly copy?: Partial<RewardScreenCopy>;

  /** Overrides for any subset of the card component's own copy. */
  readonly cardCopy?: Partial<RelicCardCopy>;
}

/**
 * The mounted reward screen: the router lifecycle, plus readers over what is
 * on screen. Every member is safe to call at any time.
 */
export interface RewardScreen extends Screen {
  /** The panel this screen created, or `null` where none was. */
  element(): HTMLElement | null;

  /** The container in force, or `null` where none resolved. */
  host(): Element | null;

  /** The offer on screen, in draw order. */
  offers(): readonly Relic[];

  /** The cards on screen, in draw order. */
  cards(): readonly RelicCard[];

  /** Whether an offer is rendered and awaiting a choice. */
  isOpen(): boolean;

  /** The relic chosen from the standing offer, or `null` while none is. */
  selectedId(): string | null;

  /**
   * Moves focus to the first card that can take it.
   *
   * @returns Whether focus moved.
   */
  focusFirst(): boolean;

  /** Whether this screen's own trap is engaged. */
  isTrapped(): boolean;

  /**
   * The rarity accents under the palette in force, sampled off the shared ramp
   * by `resolveRarityColor` of ../../theme/themes. No colour is declared here.
   *
   * @returns One 6-digit hex per tier, and an empty string for a tier that
   *   could not be sampled, which is reported.
   */
  rarityAccents(): Readonly<Record<RarityTier, string>>;

  /** The paint rung this surface occupies. */
  layer(): number;

  /** `unmount`, under the name every other component exposes. */
  destroy(): void;
}

function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Narrows a context to the `reward` one.
 *
 * @param context Context handed to a lifecycle member.
 * @returns The reward context, or `null` for any other state.
 */
function asRewardContext(
  context: ScreenContext,
): RewardScreenContext | null {
  return context.screen === 'reward' ? context : null;
}

/**
 * Narrows an element to the HTML element whose attributes this module reads
 * and writes.
 *
 * @param element Element to narrow.
 * @returns The element, or `null` where it carries no attribute surface.
 */
function asHtmlElement(element: Element | null): HTMLElement | null {
  if (element === null) {
    return null;
  }

  return typeof (element as { getAttribute?: unknown }).getAttribute ===
    'function'
    ? (element as HTMLElement)
    : null;
}

/**
 * Whether a string names one of the six hooks.
 *
 * @param value Candidate name.
 * @returns Whether the name is a member of `HOOK_NAMES`.
 */
function isHookName(value: string): value is HookName {
  return (HOOK_NAMES as readonly string[]).includes(value);
}

/**
 * Whether a string names one of the four rarity tiers.
 *
 * @param value Candidate tier.
 * @returns Whether the tier is a member of `rarityTiers`.
 */
function isRarityTier(value: string): value is RarityTier {
  return (rarityTiers as readonly string[]).includes(value);
}

/**
 * The neutral hook handler a view-only projection binds.
 *
 * A handler returning nothing leaves the accumulated payload as it stands, so
 * this marks a binding for the badge derivation of ../components/relic-card —
 * which tests each of `HOOK_NAMES` for a function — while transforming
 * nothing if it were ever dispatched. A projected relic is used for rendering
 * alone and is never handed to the engine, the hook bus or the registry.
 */
function viewOnlyHookMarker(): void {
  return;
}

/**
 * Builds a handler table marking the hooks a plain card says it binds.
 *
 * @param hooks Hook names the card carried.
 * @param relicId Identifier the names are reported against.
 * @param reporter Contained sink.
 * @returns A table carrying the neutral marker under each recognised name.
 */
function markBoundHooks(
  hooks: readonly string[],
  relicId: string,
  reporter: UiReporter,
): HookHandlerTable {
  const table: { -readonly [K in HookName]?: () => void } = {};

  for (const hook of hooks) {
    if (isHookName(hook)) {
      table[hook] = viewOnlyHookMarker;

      continue;
    }

    reporter.log('warn', 'reward offer names an unknown hook', {
      context: REPORT_CONTEXT,
      relicId,
      hook,
    });
  }

  return Object.freeze(table);
}

/**
 * Projects plain card data as the relic shape ../components/relic-card
 * renders.
 *
 * @param card The offer as the context carried it.
 * @param reporter Contained sink.
 * @returns A relic-shaped value for rendering.
 */
function projectCardAsRelic(card: RewardCard, reporter: UiReporter): Relic {
  const rarity: Rarity = isRarityTier(card.rarity)
    ? card.rarity
    : rarityTiers[0];

  if (!isRarityTier(card.rarity)) {
    reporter.log('warn', 'reward offer carries an unknown rarity', {
      context: REPORT_CONTEXT,
      relicId: card.id,
      rarity: card.rarity,
    });
  }

  const projected: Relic =
    card.charges === undefined
      ? {
          id: card.id,
          name: card.name,
          rarity,
          description: card.description,
          hooks: markBoundHooks(card.hooks, card.id, reporter),
        }
      : {
          id: card.id,
          name: card.name,
          rarity,
          description: card.description,
          hooks: markBoundHooks(card.hooks, card.id, reporter),
          charges: card.charges,
        };

  return Object.freeze(projected);
}

/**
 * Resolves the offer to render, in three tiers.
 *
 * @param context The reward context.
 * @param resolver Catalogue resolver, where the caller supplied one.
 * @param reporter Contained sink.
 * @returns The offer, in draw order.
 */
function resolveOffer(
  context: RewardScreenContext,
  resolver: ((relicId: string) => Relic | null) | undefined,
  reporter: UiReporter,
): readonly Relic[] {
  if (context.drawn.length > 0) {
    return Object.freeze([...context.drawn]);
  }

  if (context.offers.length === 0) {
    return Object.freeze([]);
  }

  let projected = 0;
  const resolved: Relic[] = context.offers.map((card: RewardCard): Relic => {
    const found = resolver === undefined ? null : safeResolve(
      resolver,
      card.id,
      reporter,
    );

    if (found !== null) {
      return found;
    }

    projected += 1;

    return projectCardAsRelic(card, reporter);
  });

  if (projected > 0) {
    reporter.count(PROJECTED_OFFER_METRIC, {
      context: REPORT_CONTEXT,
      projected,
      offers: resolved.length,
    });
  }

  return Object.freeze(resolved);
}

/**
 * Calls a caller's catalogue resolver without letting it throw inward.
 *
 * @param resolver Resolver supplied by the composition.
 * @param relicId Identifier to resolve.
 * @param reporter Contained sink.
 * @returns The relic, or `null` where none was found or the resolver raised.
 */
function safeResolve(
  resolver: (relicId: string) => Relic | null,
  relicId: string,
  reporter: UiReporter,
): Relic | null {
  try {
    return resolver(relicId) ?? null;
  } catch (error: unknown) {
    reporter.error('reward offer resolver raised', error, {
      context: REPORT_CONTEXT,
      relicId,
    });

    return null;
  }
}

/**
 * Reports an offer whose shape does not match what one reward presents.
 *
 * @param offer The offer about to be rendered.
 * @param reporter Contained sink.
 */
function auditOffer(offer: readonly Relic[], reporter: UiReporter): void {
  if (offer.length === 0) {
    reporter.count(EMPTY_OFFER_METRIC, { context: REPORT_CONTEXT });
    reporter.log('warn', 'reward screen was handed an empty offer', {
      context: REPORT_CONTEXT,
      expected: EXPECTED_OFFER_COUNT,
    });

    return;
  }

  if (offer.length !== EXPECTED_OFFER_COUNT) {
    reporter.count(OFFER_COUNT_METRIC, {
      context: REPORT_CONTEXT,
      offers: offer.length,
      expected: EXPECTED_OFFER_COUNT,
    });
    reporter.log('warn', 'reward offer does not hold three relics', {
      context: REPORT_CONTEXT,
      offers: offer.length,
      expected: EXPECTED_OFFER_COUNT,
    });
  }

  const seen = new Set<string>();
  const repeated: string[] = [];

  for (const relic of offer) {
    const id = typeof relic.id === 'string' ? relic.id : '';

    if (seen.has(id)) {
      repeated.push(id);

      continue;
    }

    seen.add(id);
  }

  if (repeated.length === 0) {
    return;
  }

  reporter.count(DUPLICATE_OFFER_METRIC, {
    context: REPORT_CONTEXT,
    offers: offer.length,
    repeated: repeated.length,
  });
  reporter.log('error', 'reward offer holds the same relic twice', {
    context: REPORT_CONTEXT,
    relicIds: repeated.join(', '),
  });
}

/**
 * Whether two offers are the same relics in the same order.
 *
 * @param left Offer on screen.
 * @param right Offer a refresh carried.
 * @returns Whether the refresh presents the standing offer.
 */
function sameOffer(
  left: readonly Relic[],
  right: readonly Relic[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (relic: Relic, index: number): boolean => relic.id === right[index]?.id,
  );
}

/**
 * Samples one accent per rarity tier off the shared ramp.
 *
 * @param theme Palette to sample under, or `undefined` for the active one.
 * @param reporter Contained sink.
 * @returns One 6-digit hex per tier, and an empty string per tier that
 *   raised.
 */
function readRarityAccents(
  theme: ThemeId | undefined,
  reporter: UiReporter,
): Readonly<Record<RarityTier, string>> {
  const accents: { -readonly [K in RarityTier]: string } = {
    common: '',
    uncommon: '',
    rare: '',
    legendary: '',
  };

  for (const tier of rarityTiers) {
    try {
      accents[tier] = resolveRarityColor(tier, theme).colorHex;
    } catch (error: unknown) {
      reporter.error('rarity accent could not be sampled', error, {
        context: REPORT_CONTEXT,
        rarity: tier,
      });
      reporter.count(ACCENT_UNRESOLVED_METRIC, {
        context: REPORT_CONTEXT,
        rarity: tier,
      });
    }
  }

  return Object.freeze(accents);
}

function mergeCopy(
  overrides: Partial<RewardScreenCopy> | undefined,
): RewardScreenCopy {
  if (overrides === undefined) {
    return defaultRewardScreenCopy;
  }

  return Object.freeze({
    heading: overrides.heading ?? defaultRewardScreenCopy.heading,
    hint: overrides.hint ?? defaultRewardScreenCopy.hint,
    announcement:
      overrides.announcement ?? defaultRewardScreenCopy.announcement,
  });
}

/** Sequence making each panel's heading identifier unique in one document. */
let headingSequence = 0;

/**
 * Mounts the reward screen.
 *
 * Nothing is read or written at import time: the container lookup, the panel's
 * creation and every report happen inside the lifecycle members. An absent
 * container is reported and every write is skipped; the screen stays safe to
 * call and reports each refusal.
 *
 * @param options Container, document, collaborators, copy and report sink.
 * @returns The mounted screen, whether or not the container resolved.
 * @example
 * ```ts
 * const screen = createRewardScreen({
 *   input,
 *   announcer,
 *   preferences,
 *   focus: focusManager,
 *   resolveRelic: (id) => catalogue.get(id) ?? null,
 *   onSelect: (relicId) => run.selectReward(relicId, engine),
 * });
 *
 * const router = createScreenRouter({ screens: { reward: screen } });
 * ```
 */
export function createRewardScreen(
  options: RewardScreenOptions = {},
): RewardScreen {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const copy = mergeCopy(options.copy);
  const announcer = options.announcer ?? null;
  const preferences = options.preferences ?? null;
  const focusManager = options.focus ?? null;
  const emitter = options.input ?? null;
  const hostSelector = options.hostSelector ?? REWARD_SCREEN_MOUNT_SELECTOR;

  headingSequence += 1;

  const headingId = `${HEADING_ID_PREFIX}${headingSequence}`;

  /** Container `mount` injected, which supersedes the option. */
  let mountedHost: Element | null = null;

  /** The panel in force, or `null` while none is rendered. */
  let panel: HTMLElement | null = null;

  /** The offer list in force, or `null` while none is rendered. */
  let grid: RelicCardGrid | null = null;

  /** The offer on screen, in draw order. */
  let offer: readonly Relic[] = Object.freeze([]);

  /** The relic chosen from the standing offer, and the selection guard. */
  let selected: string | null = null;

  /** This screen's own trap, or the adopted one. */
  let engagedTrap: FocusTrapHandle | null = null;

  /** Whether the engaged trap is this screen's to release. */
  let ownsTrap = false;

  /** Whether an offer is rendered and awaiting a choice. */
  let open = false;

  /** Whether `unmount` has run. */
  let unmounted = false;

  /**
   * Refuses a member called after `unmount`, so a late lifecycle call from a
   * router being torn down changes nothing and is visible.
   *
   * @param member Member that was called.
   * @returns Whether the call is refused.
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

  /**
   * The container in force: the one `mount` injected, then the one the caller
   * supplied, then the one the selector resolves. Every lookup is guarded and
   * every miss is reported (I12).
   *
   * @param member Member the lookup is reported against.
   * @returns The container, or `null`.
   */
  const currentHost = (member: string): Element | null => {
    if (mountedHost !== null) {
      return mountedHost;
    }

    if (options.host !== undefined && options.host !== null) {
      return options.host;
    }

    if (options.host === null) {
      reporter.count(NO_HOST_METRIC, {
        context: REPORT_CONTEXT,
        mount: HOST_MOUNT,
        member,
        reason: 'injected-null',
      });

      return null;
    }

    const resolved = resolveMount<HTMLElement>(hostSelector, {
      reporter: options.reporter,
      context: REPORT_CONTEXT,
      name: HOST_MOUNT,
    });

    if (resolved === null) {
      reporter.count(NO_HOST_METRIC, {
        context: REPORT_CONTEXT,
        mount: HOST_MOUNT,
        member,
        reason: 'no-match',
      });
    }

    return resolved;
  };

  /**
   * The document the panel is created in: the caller's, then the container's,
   * then the ambient one.
   *
   * @param host Container in force.
   * @param member Member the absence is reported against.
   * @returns The document, or `null`.
   */
  const documentFor = (host: Element, member: string): Document | null => {
    const owner =
      options.document ?? host.ownerDocument ?? readAmbientDocument();

    if (owner === null) {
      reporter.count(NO_DOCUMENT_METRIC, {
        context: REPORT_CONTEXT,
        member,
      });
      reporter.log('warn', 'reward screen has no document to render into', {
        context: REPORT_CONTEXT,
        member,
      });
    }

    return owner;
  };

  /**
   * The effective reduced-motion value: the option, then the store, then the
   * value the transition was read under, and `undefined` to leave the card
   * component's own platform detection in charge.
   *
   * @param context Reward context, where one is at hand.
   * @returns The value, or `undefined`.
   */
  const readReducedMotion = (
    context: RewardScreenContext | null,
  ): boolean | undefined => {
    if (options.reducedMotion !== undefined) {
      return options.reducedMotion;
    }

    if (preferences !== null) {
      try {
        return preferences.isReducedMotion();
      } catch (error: unknown) {
        reporter.error('reduced-motion preference read threw', error, {
          context: REPORT_CONTEXT,
        });
      }
    }

    return context === null ? undefined : context.reducedMotion;
  };

  /**
   * Verifies the dialog semantics index.html declares on the container, and
   * supplies one only where the markup carries none.
   *
   * index.html L99 already declares `role="dialog"`, `aria-modal="true"` and
   * `aria-label="Choose a relic"`, so this writes nothing in the shipped
   * markup; each value it does have to supply is reported.
   *
   * @param host Container in force.
   */
  const ensureDialogSemantics = (host: Element): void => {
    const element = asHtmlElement(host);

    if (element === null) {
      return;
    }

    const supply = (attribute: string, value: string): void => {
      const present = element.getAttribute(attribute);

      if (present !== null && present.length > 0) {
        return;
      }

      element.setAttribute(attribute, value);
      reporter.count(SEMANTICS_SUPPLIED_METRIC, {
        context: REPORT_CONTEXT,
        attribute,
      });
      reporter.log('warn', 'reward container was missing a dialog attribute', {
        context: REPORT_CONTEXT,
        attribute,
        selector: hostSelector,
      });
    };

    supply(ROLE_ATTRIBUTE, DIALOG_ROLE);
    supply(MODAL_ATTRIBUTE, 'true');
    supply(LABEL_ATTRIBUTE, copy.heading);
  };

  /**
   * Reports a list another surface had already rendered into the container.
   *
   * @param host Container in force.
   */
  const auditForeignSurface = (host: Element): void => {
    if (panel !== null) {
      return;
    }

    if (typeof host.querySelector !== 'function') {
      return;
    }

    const existing = host.querySelector(`.${rewardScreenClasses.offers}`);

    if (existing === null) {
      return;
    }

    reporter.count(FOREIGN_SURFACE_METRIC, { context: REPORT_CONTEXT });
    reporter.log(
      'warn',
      'another surface had already rendered a reward offer',
      {
        context: REPORT_CONTEXT,
        selector: hostSelector,
      },
    );
  };

  /**
   * Withdraws every card from activation, which is the selection guard's
   * teeth: a withdrawn card calls no handler at all, so a second activation
   * cannot publish a second `selectReward` from one offer.
   *
   * A withdrawn card stays focusable and announceable, as style/_reward.scss's
   * `aria-disabled` block expects.
   *
   * @param chosenId Identifier of the card that was chosen.
   */
  const closeOffer = (chosenId: string): void => {
    open = false;

    if (grid === null) {
      return;
    }

    for (const card of grid.cards()) {
      card.setDisabled(true);

      if (card.relic().id === chosenId) {
        card.setSelected(true);
      }
    }
  };

  /**
   * Announces the acquisition in PRIMITIVES — name, tier and, where the relic
   * carries one, its budget. The relic object itself is never handed to the
   * region: ../a11y/live-region names no type of src/relics.
   *
   * SPOKEN ONLY BY A STAND-ALONE MOUNT. The cards are constructed with no region
   * of their own, so within this module the acquisition is announced here and
   * nowhere else — but a composition whose reward transaction announces the
   * acquisition itself supplies no `announcer` at all, and this then speaks
   * nothing. src/main.ts is such a composition. DL-REWARD-07, DL-REWARD-14.
   *
   * @param relic The chosen relic.
   */
  const announceAcquisition = (relic: Relic): void => {
    if (announcer === null) {
      return;
    }

    const name = typeof relic.name === 'string' ? relic.name : relic.id;
    const rarity = typeof relic.rarity === 'string' ? relic.rarity : '';
    const charges =
      typeof relic.charges === 'number' && Number.isFinite(relic.charges)
        ? relic.charges
        : undefined;

    try {
      announcer.announce(
        charges === undefined
          ? { kind: 'relicAcquired', name, rarity }
          : { kind: 'relicAcquired', name, rarity, charges },
      );
    } catch (error: unknown) {
      reporter.error('relic acquisition announcement threw', error, {
        context: REPORT_CONTEXT,
        relicId: relic.id,
      });
    }
  };

  /**
   * Publishes the action for one activation.
   *
   * The payload is the card's zero-based offer index, which is what
   * `selectReward` of ../../input/keymap declares and what a subscriber
   * resolves against the offer the controller is standing on. The identifier
   * travels to `onSelect` instead.
   *
   * @param index Zero-based position of the chosen card in the offer.
   * @param relicId Identifier of the chosen relic.
   * @returns Whether the transaction accepted the choice. An absent handler,
   *   and one answering nothing, both read as acceptance; a handler that raises
   *   reads as a refusal.
   */
  const publishSelection = (index: number, relicId: string): boolean => {
    if (emitter !== null) {
      try {
        emitter.emit(SELECT_REWARD_ACTION, index);
      } catch (error: unknown) {
        reporter.error('reward selection publication threw', error, {
          context: REPORT_CONTEXT,
          relicId,
          index,
        });
      }
    }

    const select = options.onSelect;

    if (select === undefined) {
      return true;
    }

    try {
      return select(relicId, index) !== false;
    } catch (error: unknown) {
      reporter.error('reward selection handler threw', error, {
        context: REPORT_CONTEXT,
        relicId,
        index,
      });

      return false;
    }
  };

  /**
   * Handles one card activation, from the card component's own `onSelect`.
   *
   * Guarded twice against a double selection: the standing choice is checked
   * here, and every card is withdrawn from activation immediately after the
   * first one, so a rapid second press reaches no handler.
   *
   * @param relic The chosen relic, as the card handed it back.
   */
  const handleSelect = (relic: Relic): void => {
    if (refuseAfterUnmount('select')) {
      return;
    }

    const relicId = typeof relic.id === 'string' ? relic.id : '';

    if (selected !== null) {
      reporter.count(SELECT_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        reason: 'already-selected',
        relicId,
        selected,
      });

      return;
    }

    const index = offer.findIndex(
      (candidate: Relic): boolean => candidate === relic,
    );
    const position =
      index >= 0
        ? index
        : offer.findIndex(
            (candidate: Relic): boolean => candidate.id === relicId,
          );

    if (position < 0) {
      reporter.count(SELECT_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        reason: 'not-offered',
        relicId,
      });
      reporter.log('warn', 'reward selection named no offered relic', {
        context: REPORT_CONTEXT,
        relicId,
      });

      return;
    }

    // THE TRANSACTION ANSWERS FIRST. Nothing is disabled, marked chosen,
    // announced or released until the controller has accepted the relic: a
    // refused press leaves the offer exactly as it was, so the player can
    // choose again. Decision DL-REWARD-12.
    const accepted = publishSelection(position, relicId);

    if (!accepted) {
      reporter.count(SELECT_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        reason: 'not-accepted',
        relicId,
      });

      return;
    }

    selected = relicId;
    closeOffer(relicId);

    reporter.count(SELECTED_METRIC, {
      context: REPORT_CONTEXT,
      relicId,
      index: position,
    });

    announceAcquisition(relic);

    // Selection is an exit path, so the trap is released here as well as in
    // `leave`, after the announcement.
    releaseTrap();
  };

  /**
   * Releases the trap this screen engaged, which restores focus and lifts every
   * inertness it applied. An adopted trap is let go of without releasing it:
   * the surface that engaged it owns its lifetime.
   *
   * Called on every exit path, so no trap is leaked. Selection is not such a
   * path; the router leaving the state resolves it.
   */
  const releaseTrap = (): void => {
    const engaged = engagedTrap;
    const owned = ownsTrap;

    engagedTrap = null;
    ownsTrap = false;

    if (engaged === null || !owned) {
      return;
    }

    engaged.release();
  };

  /**
   * Resolves the element focus returns to when the trap releases, once per
   * engage. `null` leaves the trap's own fallback in charge.
   *
   * @returns The element, or `null`.
   */
  const readRestoreTarget = (): HTMLElement | null => {
    const resolve = options.restoreFocusTo;

    if (resolve === undefined) {
      return null;
    }

    try {
      return asHtmlElement(resolve() ?? null);
    } catch (error: unknown) {
      reporter.error('reward focus-restore resolver threw', error, {
        context: REPORT_CONTEXT,
      });

      return null;
    }
  };

  /** Reports the Escape press outward. Nothing is published from here. */
  const handleEscape = (): void => {
    const escape = options.onEscape;

    if (escape === undefined) {
      return;
    }

    try {
      escape();
    } catch (error: unknown) {
      reporter.error('reward escape handler threw', error, {
        context: REPORT_CONTEXT,
      });
    }
  };

  /**
   * Engages the trap over the container, or adopts one already engaged on it.
   *
   * @param host Container focus is held inside.
   * @param reducedMotion Effective reduced-motion value for the placement.
   */
  const engageTrap = (
    host: Element,
    reducedMotion: boolean | undefined,
  ): void => {
    releaseTrap();

    if (focusManager !== null) {
      const standing = focusManager.activeTrap();

      if (standing !== null && standing.container === host) {
        engagedTrap = standing;
        ownsTrap = false;
        reporter.count(TRAP_ADOPTED_METRIC, {
          context: REPORT_CONTEXT,
          label: standing.label,
        });

        return;
      }
    }

    const trapOptions = {
      label: 'reward',
      context: REPORT_CONTEXT,
      reporter: options.reporter,
      reducedMotion,
      restoreFocusTo: readRestoreTarget(),
      inertBackground: options.inertBackground,
      onEscape: (): void => {
        handleEscape();
      },
    };
    const engaged =
      focusManager === null
        ? trap(host, trapOptions)
        : focusManager.trap(host, trapOptions);

    if (engaged === null) {
      reporter.count(TRAP_REFUSED_METRIC, { context: REPORT_CONTEXT });

      return;
    }

    engagedTrap = engaged;
    ownsTrap = true;
  };

  /**
   * Takes the panel down: every card is destroyed through the list's own
   * teardown and the panel is detached. The trap is untouched, so a re-render
   * inside one visit does not disturb focus containment.
   */
  const takeDownPanel = (): void => {
    const rendered = grid;

    grid = null;

    if (rendered !== null) {
      rendered.destroy();
    }

    const surface = panel;

    panel = null;

    if (surface !== null && surface.parentNode !== null) {
      surface.parentNode.removeChild(surface);
    }

    open = false;
  };

  /**
   * Renders one offer, in the order it was handed over.
   *
   * Nothing here samples: `next` is what the context carried. The panel is
   * built, the list is created inside it through `createRelicCardGrid`, and
   * the container's children are replaced so exactly one offer is ever on
   * screen.
   *
   * @param next The offer to present, in draw order.
   * @param context Reward context, where one is at hand.
   * @param resolvedHost Container the caller already resolved, so one entry
   *   performs one lookup and reports one miss.
   * @returns Whether an offer was rendered.
   */
  const renderOffer = (
    next: readonly Relic[],
    context: RewardScreenContext | null,
    resolvedHost?: Element | null,
  ): boolean => {
    const host =
      resolvedHost === undefined ? currentHost('render') : resolvedHost;

    if (host === null) {
      return false;
    }

    const owner = documentFor(host, 'render');

    if (owner === null) {
      return false;
    }

    auditForeignSurface(host);
    auditOffer(next, reporter);
    ensureDialogSemantics(host);
    takeDownPanel();

    const surface = owner.createElement('div');

    surface.className = rewardScreenClasses.panel;

    const heading = owner.createElement('h2');

    heading.className = rewardScreenClasses.heading;
    heading.id = headingId;
    heading.textContent = copy.heading;

    const hint = owner.createElement('p');

    hint.className = rewardScreenClasses.hint;
    hint.textContent = copy.hint;

    surface.setAttribute(LABELLED_BY_ATTRIBUTE, headingId);
    surface.append(heading, hint);

    // The list appends itself to the panel, so the panel reaches the container
    // already carrying it and the container is written exactly once.
    //
    // `announcer` is withheld from the cards: this screen makes the acquisition
    // announcement itself, in `announceAcquisition`. Decision DL-REWARD-07.
    const built = createRelicCardGrid({
      relics: next,
      host: surface,
      document: owner,
      reporter: options.reporter,
      announcer: null,
      preferences,
      reducedMotion: readReducedMotion(context),
      theme: options.theme,
      copy: options.cardCopy,
      onSelect: handleSelect,
    });

    host.replaceChildren(surface);

    panel = surface;
    grid = built;
    offer = Object.freeze([...next]);
    selected = null;
    open = offer.length > 0;

    reporter.count(RENDERED_METRIC, {
      context: REPORT_CONTEXT,
      offers: offer.length,
      stageIndex: context === null ? -1 : context.stageIndex,
      layer: REWARD_SCREEN_LAYER,
    });

    return true;
  };

  /**
   * Places focus on the first card that can take it.
   *
   * @returns Whether focus moved.
   */
  const focusFirstCard = (): boolean => {
    if (grid === null) {
      return false;
    }

    const moved = grid.focusFirst();

    if (!moved) {
      reporter.count(FOCUS_REFUSED_METRIC, {
        context: REPORT_CONTEXT,
        offers: offer.length,
      });
    }

    return moved;
  };

  /** Announces the state, as free text, where a region was supplied. */
  const announceScreen = (): void => {
    if (announcer === null) {
      return;
    }

    try {
      announcer.announceText(copy.announcement);
    } catch (error: unknown) {
      reporter.error('reward screen announcement threw', error, {
        context: REPORT_CONTEXT,
      });
    }
  };

  const mount = (host: Element): void => {
    if (refuseAfterUnmount('mount')) {
      return;
    }

    if (mountedHost !== null && mountedHost !== host) {
      reporter.log('warn', 'reward screen was re-mounted on a new container', {
        context: REPORT_CONTEXT,
        selector: hostSelector,
      });
      takeDownPanel();
    }

    mountedHost = host;
    ensureDialogSemantics(host);
  };

  /** Whether this screen engages a trap of its own. DL-REWARD-12. */
  const ownTrap = options.trapFocus ?? true;

  /** Whether this screen places focus and announces on entry. DL-REWARD-12. */
  const ownEntry = options.announceEntry ?? true;

  /**
   * The line the router reads on entry: the offer, card by card, in the order
   * the digits address them.
   *
   * The same words this screen speaks for itself where it owns its entry, so
   * the announcement does not depend on which layer is speaking. Decision
   * DL-REWARD-12.
   *
   * @param context The context the entry carried.
   * @returns The line, or `null` for any other state.
   */
  const announcement = (context: ScreenContext): string | null => {
    const reward = asRewardContext(context);

    if (reward === null) {
      return null;
    }

    const named = reward.offers
      .map((card, index): string => `${index + 1}, ${card.name}`)
      .join('; ');

    return named === '' ? copy.announcement : `${copy.announcement} ${named}.`;
  };

  const enter = (context: ScreenContext): void => {
    if (refuseAfterUnmount('enter')) {
      return;
    }

    const reward = asRewardContext(context);

    if (reward === null) {
      reporter.count(WRONG_CONTEXT_METRIC, {
        context: REPORT_CONTEXT,
        member: 'enter',
        screen: context.screen,
      });

      return;
    }

    const host = currentHost('enter');
    const resolved = resolveOffer(reward, options.resolveRelic, reporter);

    if (!renderOffer(resolved, reward, host)) {
      return;
    }

    if (host !== null && ownTrap) {
      engageTrap(host, readReducedMotion(reward));
    }

    if (ownEntry) {
      focusFirstCard();
      announceScreen();
    }
  };

  const update = (context: ScreenContext): void => {
    if (refuseAfterUnmount('update')) {
      return;
    }

    const reward = asRewardContext(context);

    if (reward === null) {
      reporter.count(WRONG_CONTEXT_METRIC, {
        context: REPORT_CONTEXT,
        member: 'update',
        screen: context.screen,
      });

      return;
    }

    const resolved = resolveOffer(reward, options.resolveRelic, reporter);

    // Idempotent and non-redrawing.
    if (resolved.length === 0 || sameOffer(offer, resolved)) {
      reporter.count(REFRESH_METRIC, {
        context: REPORT_CONTEXT,
        offers: offer.length,
        rendered: panel !== null,
        selected: selected ?? '',
      });

      if (panel === null && offer.length > 0) {
        renderOffer(offer, reward);
      }

      return;
    }

    renderOffer(resolved, reward);
    focusFirstCard();
  };

  const leave = (): void => {
    if (refuseAfterUnmount('leave')) {
      return;
    }

    releaseTrap();
    takeDownPanel();
  };

  const unmount = (): void => {
    if (refuseAfterUnmount('unmount')) {
      return;
    }

    unmounted = true;
    releaseTrap();
    takeDownPanel();
    mountedHost = null;
    offer = Object.freeze([]);
    selected = null;
  };

  return Object.freeze({
    mount,
    enter,
    update,
    announcement,
    leave,
    unmount,

    element: (): HTMLElement | null => panel,

    host: (): Element | null => mountedHost ?? options.host ?? null,

    offers: (): readonly Relic[] => offer,

    cards: (): readonly RelicCard[] =>
      grid === null ? Object.freeze([]) : grid.cards(),

    isOpen: (): boolean => open,

    selectedId: (): string | null => selected,

    focusFirst: (): boolean => focusFirstCard(),

    isTrapped: (): boolean => engagedTrap !== null && engagedTrap.isActive(),

    rarityAccents: (): Readonly<Record<RarityTier, string>> =>
      readRarityAccents(options.theme, reporter),

    layer: (): number => REWARD_SCREEN_LAYER,

    destroy: (): void => {
      unmount();
    },
  });
}
