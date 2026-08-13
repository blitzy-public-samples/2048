// Contract suite for the reward screen driven DIRECTLY, past the router.
//
// The screen was exercised only through the composition, which supplies a
// well-formed three-relic offer, a real focus manager, a resolver that always
// resolves and a transaction that always accepts. Every other branch it
// declares — projecting a card the catalogue cannot resolve, auditing a
// container another surface already rendered into, engaging or adopting a focus
// trap, publishing the action, and the announcement fallback — had no direct
// test. Most consequentially, the rule that a REFUSED or THROWING selection
// leaves the offer standing had none, and that rule is the only thing that lets
// a player choose again after the run controller says no.

import { afterEach, describe, expect, it } from 'vitest';

import type { Relic } from '../../../src/relics/relic-types';
import { createRewardScreen } from '../../../src/ui/screens/reward';
import {
  EXPECTED_OFFER_COUNT,
  REWARD_SCREEN_LAYER,
  REWARD_SCREEN_MOUNT_SELECTOR,
  defaultRewardScreenCopy,
  rewardScreenClasses,
} from '../../../src/ui/screens/reward';
import type {
  RewardScreen,
  RewardScreenOptions,
} from '../../../src/ui/screens/reward';
import type { RewardCard, ScreenContext } from '../../../src/ui/screen-router';
import type { UiReporter } from '../../../src/ui/a11y/settings';

/** The container index.html declares for this screen. */
const MARKUP = `
  <div class="screen-layer">
    <div class="screen" id="screen-reward" data-screen="reward" role="dialog"
         aria-modal="true"></div>
  </div>
`;

/** One catalogue relic, as the draw hands it over. */
const relicOf = (id: string, overrides: Partial<Relic> = {}): Relic => ({
  id,
  name: `${id} name`,
  rarity: 'common',
  description: `${id} description`,
  hooks: { onMerge: (): undefined => undefined },
  ...overrides,
});

/** One reward card, as a persisted round projects it. */
const cardOf = (id: string): RewardCard => ({
  id,
  name: `${id} card`,
  rarity: 'rare',
  description: `${id} card description`,
  hooks: ['onSpawn'],
});

/** Three relics, which is the offer size the draw produces. */
const OFFER: readonly Relic[] = Object.freeze([
  relicOf('first-relic'),
  relicOf('second-relic', { rarity: 'rare', charges: 2 }),
  relicOf('third-relic', { rarity: 'legendary' }),
]);

/** Every report one screen made. */
interface Sink {
  readonly reporter: UiReporter;
  readonly counts: { name: string; fields?: unknown }[];
  readonly messages: string[];
  readonly errors: string[];
  readonly countOf: (name: string) => number;
  readonly fieldsOf: (name: string) => unknown;
}

/**
 * @returns A recording reporter and readers over what it recorded.
 */
const sink = (): Sink => {
  const counts: { name: string; fields?: unknown }[] = [];
  const messages: string[] = [];
  const errors: string[] = [];

  return {
    reporter: {
      log: (_level, message): void => {
        messages.push(message);
      },
      count: (name, fields): void => {
        counts.push({ name, fields });
      },
      error: (message): void => {
        errors.push(message);
      },
    },
    counts,
    messages,
    errors,
    countOf: (name: string): number =>
      counts.filter((entry): boolean => entry.name === name).length,
    fieldsOf: (name: string): unknown =>
      counts.filter((entry): boolean => entry.name === name).at(-1)?.fields,
  };
};

/**
 * A live region that records what it was told to say.
 *
 * The port has TWO members this screen uses: `announceText` for the screen's own
 * entry line, and `announce` for the structured relic-acquisition announcement.
 *
 * @param lines Collector every line is pushed onto.
 * @returns The region.
 */
const recordingRegion = (lines: string[]): RewardScreenOptions['announcer'] =>
  ({
    announceText: (text: string): void => {
      lines.push(text);
    },
    announce: (announcement: { name?: string; text?: string }): void => {
      lines.push(announcement.name ?? announcement.text ?? '');
    },
  }) as unknown as RewardScreenOptions['announcer'];

/** A reward context, with the offer supplied as drawn relics by default. */
const context = (
  overrides: Partial<{
    drawn: readonly Relic[];
    offers: readonly RewardCard[];
    reducedMotion: boolean;
    refresh: boolean;
  }> = {},
): ScreenContext =>
  ({
    screen: 'reward',
    trigger: 'stageEnd',
    reducedMotion: overrides.reducedMotion ?? false,
    host: document.querySelector(REWARD_SCREEN_MOUNT_SELECTOR),
    refresh: overrides.refresh ?? false,
    offers: overrides.offers ?? [],
    drawn: overrides.drawn ?? OFFER,
  }) as unknown as ScreenContext;

/** The container this screen renders into. */
const container = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    REWARD_SCREEN_MOUNT_SELECTOR,
  );

  if (found === null) {
    throw new Error('the fixture lost the reward container');
  }

  return found;
};

let screen: RewardScreen | null = null;

afterEach(() => {
  screen?.unmount();
  screen = null;
  document.body.innerHTML = '';
});

/**
 * Mounts a screen over the fixture and enters it once.
 *
 * @param options Screen options, merged over the defaults.
 * @param entered Context overrides for the entry.
 * @returns The screen and its sink.
 */
const open = (
  options: RewardScreenOptions = {},
  entered: Parameters<typeof context>[0] = {},
): { readonly screen: RewardScreen; readonly reports: Sink } => {
  document.body.innerHTML = MARKUP;

  const reports = sink();
  const built = createRewardScreen({
    document,
    reporter: reports.reporter,
    ...options,
  });

  screen = built;
  built.mount(container());
  built.enter(context(entered));

  return { screen: built, reports };
};

/** The cards on screen, as their identifiers. */
const renderedIds = (): readonly string[] =>
  Array.from(
    container().querySelectorAll<HTMLElement>('[data-relic-id]'),
  ).map((card): string => card.getAttribute('data-relic-id') ?? '');

describe('a standalone reward screen', () => {
  it('renders one card per drawn relic, in draw order', () => {
    const { screen: panel, reports } = open();

    expect(panel.isOpen()).toBe(true);
    expect(panel.element()).not.toBeNull();
    expect(panel.host()).toBe(container());
    expect(panel.layer()).toBe(REWARD_SCREEN_LAYER);
    expect(panel.offers().map((relic): string => relic.id)).toEqual([
      'first-relic',
      'second-relic',
      'third-relic',
    ]);
    expect(panel.cards()).toHaveLength(EXPECTED_OFFER_COUNT);
    expect(renderedIds()).toEqual([
      'first-relic',
      'second-relic',
      'third-relic',
    ]);

    // The heading and the hint are the module's own copy.
    expect(container().textContent).toContain(defaultRewardScreenCopy.heading);
    expect(reports.errors).toEqual([]);
  });

  it('projects a card the catalogue cannot resolve, and reports it', () => {
    // The persisted-round path: the context carries CARDS rather than relics, so
    // each is resolved through the injected resolver and projected where the
    // resolver answers nothing.
    const { screen: panel, reports } = open(
      {
        resolveRelic: (relicId: string): Relic | null =>
          relicId === 'known-relic' ? relicOf('known-relic') : null,
      },
      {
        drawn: [],
        offers: [cardOf('known-relic'), cardOf('unknown-relic')],
      },
    );

    expect(panel.offers().map((relic): string => relic.id)).toEqual([
      'known-relic',
      'unknown-relic',
    ]);
    expect(renderedIds()).toEqual(['known-relic', 'unknown-relic']);

    // ONE was projected, and that is reported with the count.
    expect(reports.countOf('ui.rewardScreen.offerProjected')).toBe(1);
    expect(reports.fieldsOf('ui.rewardScreen.offerProjected')).toMatchObject({
      projected: 1,
      offers: 2,
    });
  });

  it('contains a resolver that raises and projects the card instead', () => {
    const { screen: panel, reports } = open(
      {
        resolveRelic: (): Relic | null => {
          throw new Error('the catalogue refused');
        },
      },
      { drawn: [], offers: [cardOf('one'), cardOf('two'), cardOf('three')] },
    );

    expect(panel.offers()).toHaveLength(3);
    expect(renderedIds()).toEqual(['one', 'two', 'three']);
    expect(reports.errors.length).toBeGreaterThan(0);
    expect(reports.countOf('ui.rewardScreen.offerProjected')).toBe(1);
  });

  it('prefers the drawn relics over the projected cards', () => {
    const { screen: panel } = open(
      {},
      { drawn: OFFER, offers: [cardOf('ignored')] },
    );

    expect(panel.offers().map((relic): string => relic.id)).toEqual([
      'first-relic',
      'second-relic',
      'third-relic',
    ]);
  });

  it('reports an offer that is empty, mis-sized or repeated', () => {
    // Three audits over one entry: nothing rendered for an empty offer.
    const empty = open({}, { drawn: [] });

    expect(empty.screen.isOpen()).toBe(false);
    expect(empty.reports.countOf('ui.rewardScreen.offerEmpty')).toBe(1);

    empty.screen.unmount();

    // Two cards where three are expected: rendered, and reported.
    const short = open({}, { drawn: [OFFER[0]!, OFFER[1]!] });

    expect(short.screen.isOpen()).toBe(true);
    expect(short.screen.cards()).toHaveLength(2);
    expect(
      short.reports.countOf('ui.rewardScreen.offerCountUnexpected'),
    ).toBe(1);
    expect(
      short.reports.fieldsOf('ui.rewardScreen.offerCountUnexpected'),
    ).toMatchObject({ offers: 2, expected: EXPECTED_OFFER_COUNT });

    short.screen.unmount();

    // The same relic twice, which the seeded draw cannot produce: reported as
    // an error, because a duplicate offer means the draw's without-replacement
    // guarantee has been broken.
    const repeated = open(
      {},
      { drawn: [OFFER[0]!, OFFER[0]!, OFFER[1]!] },
    );

    expect(
      repeated.reports.countOf('ui.rewardScreen.offerDuplicate'),
    ).toBe(1);
    expect(
      repeated.reports.messages.some((message): boolean =>
        message.includes('same relic twice'),
      ),
    ).toBe(true);
  });

  it('audits a container another surface already rendered into', () => {
    document.body.innerHTML = MARKUP;

    // A list of the class the card component uses is already there, which is
    // what a second reward surface over one container looks like.
    const foreign = document.createElement('ul');

    foreign.className = rewardScreenClasses.offers;
    container().append(foreign);

    const reports = sink();
    const built = createRewardScreen({
      document,
      reporter: reports.reporter,
    });

    screen = built;
    built.mount(container());
    built.enter(context());

    expect(reports.countOf('ui.rewardScreen.foreignSurface')).toBe(1);
    expect(
      reports.messages.some((message): boolean =>
        message.includes('already rendered a reward offer'),
      ),
    ).toBe(true);

    // And it still renders its own offer.
    expect(built.isOpen()).toBe(true);
    expect(built.cards()).toHaveLength(EXPECTED_OFFER_COUNT);
  });

  it('refuses a context for another screen', () => {
    document.body.innerHTML = MARKUP;

    const reports = sink();
    const built = createRewardScreen({
      document,
      reporter: reports.reporter,
    });

    screen = built;
    built.mount(container());
    built.enter({
      ...(context() as unknown as Record<string, unknown>),
      screen: 'runSummary',
    } as unknown as ScreenContext);

    expect(built.isOpen()).toBe(false);
    expect(reports.countOf('ui.rewardScreen.contextMismatch')).toBe(1);
    expect(reports.fieldsOf('ui.rewardScreen.contextMismatch')).toMatchObject({
      member: 'enter',
      screen: 'runSummary',
    });
  });
});

describe('a selection the transaction refuses', () => {
  it('leaves the offer standing so the player can choose again', () => {
    // The rule this whole screen is built around: nothing is disabled, marked
    // chosen, announced or released until the transaction has ACCEPTED the
    // relic. A refused press must leave three usable cards. DL-REWARD-12.
    const attempts: string[] = [];
    const { screen: panel, reports } = open({
      onSelect: (relicId): boolean => {
        attempts.push(relicId);

        return false;
      },
      trapFocus: false,
    });

    const card = container().querySelector<HTMLElement>(
      '[data-relic-id="second-relic"]',
    );

    expect(card).not.toBeNull();

    card?.click();

    expect(attempts).toEqual(['second-relic']);

    // STILL OPEN, still three cards, and nothing chosen.
    expect(panel.selectedId()).toBeNull();
    expect(panel.isOpen()).toBe(true);
    expect(panel.cards()).toHaveLength(EXPECTED_OFFER_COUNT);
    expect(card?.getAttribute('aria-disabled')).not.toBe('true');
    expect(reports.fieldsOf('ui.rewardScreen.selectRefused')).toMatchObject({
      reason: 'not-accepted',
      relicId: 'second-relic',
    });
    expect(reports.countOf('ui.rewardScreen.selected')).toBe(0);

    // AND A SECOND PRESS STILL REACHES THE TRANSACTION, which is the point.
    card?.click();

    expect(attempts).toEqual(['second-relic', 'second-relic']);
  });

  it('reads a handler that raises as a refusal, and reports it', () => {
    const { screen: panel, reports } = open({
      onSelect: (): boolean => {
        throw new Error('the controller refused');
      },
      trapFocus: false,
    });

    const card = container().querySelector<HTMLElement>(
      '[data-relic-id="first-relic"]',
    );

    expect(() => {
      card?.click();
    }).not.toThrow();

    expect(panel.selectedId()).toBeNull();
    expect(panel.isOpen()).toBe(true);
    expect(reports.errors).toContain('reward selection handler threw');
    expect(reports.fieldsOf('ui.rewardScreen.selectRefused')).toMatchObject({
      reason: 'not-accepted',
    });
  });

  it('accepts a handler that answers nothing at all', () => {
    // An absent answer is an acceptance: a caller driving the screen without a
    // transaction still closes the offer.
    const { screen: panel } = open({
      onSelect: (): void => undefined,
      trapFocus: false,
    });

    container()
      .querySelector<HTMLElement>('[data-relic-id="third-relic"]')
      ?.click();

    expect(panel.selectedId()).toBe('third-relic');
    expect(panel.isOpen()).toBe(false);
  });

  it('withdraws every card once one is accepted', () => {
    const attempts: string[] = [];
    const { screen: panel, reports } = open({
      onSelect: (relicId): boolean => {
        attempts.push(relicId);

        return true;
      },
      trapFocus: false,
    });

    const first = container().querySelector<HTMLElement>(
      '[data-relic-id="first-relic"]',
    );
    const second = container().querySelector<HTMLElement>(
      '[data-relic-id="second-relic"]',
    );

    first?.click();

    expect(panel.selectedId()).toBe('first-relic');
    expect(panel.isOpen()).toBe(false);
    expect(reports.countOf('ui.rewardScreen.selected')).toBe(1);

    // A SECOND PRESS REACHES NOTHING, on either card: the withdrawal is the
    // guard's teeth, so one offer cannot take two relics.
    first?.click();
    second?.click();

    expect(attempts).toEqual(['first-relic']);
    expect(panel.selectedId()).toBe('first-relic');
  });

  it('publishes the card index on the injected emitter', () => {
    // `selectReward` of the keymap carries the zero-based INDEX, not the
    // identifier, so a subscriber resolves it against the standing offer.
    const published: { action: string; payload: unknown }[] = [];
    const { screen: panel } = open({
      trapFocus: false,
      input: {
        emit: (action: string, payload: unknown): void => {
          published.push({ action, payload });
        },
      } as unknown as RewardScreenOptions['input'],
    });

    container()
      .querySelector<HTMLElement>('[data-relic-id="third-relic"]')
      ?.click();

    expect(published).toEqual([{ action: 'selectReward', payload: 2 }]);
    expect(panel.selectedId()).toBe('third-relic');
  });

  it('contains an emitter that raises and still completes the selection', () => {
    const { screen: panel, reports } = open({
      trapFocus: false,
      input: {
        emit: (): void => {
          throw new Error('the emitter refused');
        },
      } as unknown as RewardScreenOptions['input'],
    });

    container()
      .querySelector<HTMLElement>('[data-relic-id="first-relic"]')
      ?.click();

    expect(reports.errors).toContain('reward selection publication threw');

    // The publication is a notification, not the transaction: the selection
    // still stands.
    expect(panel.selectedId()).toBe('first-relic');
    expect(panel.isOpen()).toBe(false);
  });
});

describe('the focus trap this screen engages', () => {
  it('engages its own trap and releases it on leave', () => {
    const { screen: panel } = open();

    expect(panel.isTrapped()).toBe(true);

    panel.leave();

    expect(panel.isTrapped()).toBe(false);
  });

  it('engages no trap where the caller withholds one', () => {
    const { screen: panel } = open({ trapFocus: false });

    expect(panel.isTrapped()).toBe(false);
    expect(panel.isOpen()).toBe(true);
  });

  it('adopts a trap the injected manager already holds on this container', () => {
    document.body.innerHTML = MARKUP;

    const reports = sink();
    const held = { active: true };
    const manager = {
      activeTrap: (): unknown => ({
        // `container`, which is the member the handle publishes and the one the
        // screen compares against its own host.
        container: container(),
        label: 'held-elsewhere',
        isActive: (): boolean => held.active,
        release: (): void => {
          held.active = false;
        },
      }),
      trap: (): unknown => {
        throw new Error('a second trap must not be engaged');
      },
    };

    const built = createRewardScreen({
      document,
      reporter: reports.reporter,
      focus: manager as unknown as RewardScreenOptions['focus'],
    });

    screen = built;
    built.mount(container());

    expect(() => {
      built.enter(context());
    }).not.toThrow();

    expect(reports.countOf('ui.rewardScreen.trapAdopted')).toBe(1);
    expect(built.isOpen()).toBe(true);

    // ADOPTED, NOT OWNED: leaving lets it go without releasing it, because the
    // surface that engaged it owns its lifetime.
    built.leave();

    expect(held.active).toBe(true);
  });

  it('reports a manager that refuses to engage, and still renders', () => {
    document.body.innerHTML = MARKUP;

    const reports = sink();
    const manager = {
      activeTrap: (): unknown => null,
      trap: (): unknown => null,
    };

    const built = createRewardScreen({
      document,
      reporter: reports.reporter,
      focus: manager as unknown as RewardScreenOptions['focus'],
    });

    screen = built;
    built.mount(container());
    built.enter(context());

    expect(reports.countOf('ui.rewardScreen.trapRefused')).toBe(1);
    expect(built.isTrapped()).toBe(false);
    expect(built.isOpen()).toBe(true);
    expect(built.cards()).toHaveLength(EXPECTED_OFFER_COUNT);
  });

  it('calls onEscape rather than closing itself', () => {
    // The reward screen is NOT cancellable — the stage is cleared and a relic
    // must be taken — so Escape is reported outward and the offer stands.
    const escapes: number[] = [];
    const { screen: panel } = open({
      onEscape: (): void => {
        escapes.push(1);
      },
    });

    container().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
      }),
    );

    expect(escapes).toHaveLength(1);
    expect(panel.isOpen()).toBe(true);
    expect(panel.selectedId()).toBeNull();
  });
});

describe('the announcement this screen makes', () => {
  it('announces the screen on entry through the injected region', () => {
    const lines: string[] = [];
    const { screen: panel } = open({
      announcer: recordingRegion(lines),
    });

    expect(lines.length).toBeGreaterThan(0);

    // `announcement(context)` is the line the router would speak for this
    // screen, which is the same copy the region above received.
    expect(panel.announcement?.(context())).not.toBe('');
  });

  it('announces the acquisition when a relic is taken', () => {
    const lines: string[] = [];

    open({
      trapFocus: false,
      announcer: recordingRegion(lines),
      onSelect: (): boolean => true,
    });

    const before = lines.length;

    container()
      .querySelector<HTMLElement>('[data-relic-id="second-relic"]')
      ?.click();

    expect(lines.length).toBeGreaterThan(before);
    expect(lines.at(-1)).toContain('second-relic');
  });

  it('skips both announcements where no region was supplied', () => {
    // Absent, both are skipped and nothing is written to a console instead —
    // which is the composition's own wiring, because its reward transaction
    // announces the acquisition. DL-REWARD-14.
    const { screen: panel, reports } = open({
      announcer: null,
      trapFocus: false,
      onSelect: (): boolean => true,
    });

    container()
      .querySelector<HTMLElement>('[data-relic-id="first-relic"]')
      ?.click();

    expect(panel.selectedId()).toBe('first-relic');
    expect(reports.errors).toEqual([]);
  });

  it('announces nothing on entry where the caller owns entry', () => {
    const lines: string[] = [];
    const { screen: panel } = open({
      announceEntry: false,
      announcer: recordingRegion(lines),
    });

    expect(lines).toEqual([]);
    expect(panel.isOpen()).toBe(true);
  });
});

describe('a call that reaches an unmounted screen', () => {
  it('is refused rather than rendering', () => {
    const { screen: panel, reports } = open();

    panel.unmount();

    expect(panel.element()).toBeNull();
    expect(panel.isOpen()).toBe(false);

    panel.enter(context());

    expect(panel.isOpen()).toBe(false);
    expect(reports.countOf('ui.rewardScreen.selected')).toBe(0);
  });
});
