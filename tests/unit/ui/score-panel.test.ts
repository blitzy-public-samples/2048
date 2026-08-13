// Contract suite for the score and best-score outlets: who owns each outlet's
// accessible name, what a write preserves, and what happens where an outlet or
// a document is absent.
//
// The two outlets are the only surfaces this product carried FORWARD unchanged
// from js/html_actuator.js L106-L125, and their labels were CSS `:after`
// content there — invisible to assistive technology. This component gives them
// real names, and the rules about ownership are what stop it removing a name
// the markup itself declared. None of those branches had a direct test: the
// component was reached only through the HUD, which supplies well-formed
// markup and therefore drives exactly one of them.

import { afterEach, describe, expect, it } from 'vitest';

import { createScorePanel } from '../../../src/ui/components/score-panel';
import type { UiReporter } from '../../../src/ui/a11y/settings';

/** Markup carrying both outlets and nothing inside them. */
const BARE_MARKUP = `
  <div class="score-container"></div>
  <div class="best-container"></div>
`;

/** Every report one panel made. */
interface Sink {
  readonly reporter: UiReporter;
  readonly counts: { name: string; fields?: unknown }[];
  readonly warnings: string[];
  readonly countOf: (name: string) => number;
}

/**
 * @returns A recording reporter and readers over what it recorded.
 */
const sink = (): Sink => {
  const counts: { name: string; fields?: unknown }[] = [];
  const warnings: string[] = [];

  return {
    reporter: {
      log: (level, message): void => {
        if (level === 'warn') {
          warnings.push(message);
        }
      },
      count: (name, fields): void => {
        counts.push({ name, fields });
      },
      error: (message): void => {
        warnings.push(message);
      },
    },
    counts,
    warnings,
    countOf: (name: string): number =>
      counts.filter((entry): boolean => entry.name === name).length,
  };
};

/** The outlet one selector resolves to, which must exist. */
const outlet = (selector: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(selector);

  if (found === null) {
    throw new Error(`the fixture lost ${selector}`);
  }

  return found;
};

/**
 * The outlet's text WITHOUT its rising-score delta.
 *
 * A rise appends a `.score-addition` node inside the outlet — js/html_actuator.js
 * L114-L120 — so the raw `textContent` carries the delta as well as the value.
 *
 * @param element Outlet to read.
 * @returns The name and the value, with the delta removed.
 */
const valueText = (element: HTMLElement): string => {
  const addition = element.querySelector('.score-addition')?.textContent ?? '';
  const whole = element.textContent ?? '';

  return addition === '' ? whole : whole.replace(addition, '');
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the accessible name each outlet carries', () => {
  it('creates a visually-hidden name where the markup declares none', () => {
    document.body.innerHTML = BARE_MARKUP;

    const reports = sink();
    const panel = createScorePanel({ document, reporter: reports.reporter });

    expect(panel.isReady()).toBe(true);

    panel.update({ score: 12, bestScore: '34' });

    const score = outlet('.score-container');
    const label = score.querySelector('.visually-hidden');

    // A REAL NODE, not `:after` content, so a screen reader can read it.
    expect(label).not.toBeNull();
    expect(label?.tagName).toBe('SPAN');
    expect(label?.textContent).toBe('Score');

    // The name comes BEFORE the value, so the outlet reads "Score 12".
    expect(valueText(score)).toBe('Score12');
    expect(valueText(outlet('.best-container'))).toBe('Best34');

    expect(reports.countOf('ui.scorePanel.label_added')).toBe(2);
    expect(reports.countOf('ui.scorePanel.label_adopted')).toBe(0);

    panel.destroy();
  });

  it('adopts a visually-hidden label the markup already placed', () => {
    document.body.innerHTML = `
      <div class="score-container">
        <span class="visually-hidden">Points earned</span>
      </div>
      <div class="best-container"></div>
    `;

    const reports = sink();
    const panel = createScorePanel({ document, reporter: reports.reporter });

    panel.updateScore(7);

    const score = outlet('.score-container');
    const labels = score.querySelectorAll('.visually-hidden');

    // ADOPTED, NOT REPLACED: one label, and it is the markup's own wording.
    expect(labels).toHaveLength(1);
    expect(labels[0]?.textContent).toBe('Points earned');
    expect(valueText(score)).toBe('Points earned7');

    expect(reports.countOf('ui.scorePanel.label_adopted')).toBe(1);

    // And the one it adopted is LEFT BEHIND on destroy, because it did not
    // create it: removing markup the document owns is not this component's to
    // do.
    panel.destroy();

    expect(score.querySelectorAll('.visually-hidden')).toHaveLength(1);
    expect(score.textContent).toContain('Points earned');
  });

  it('leaves an outlet that names itself through aria-label alone', () => {
    document.body.innerHTML = `
      <div class="score-container" aria-label="Current score"></div>
      <div class="best-container" aria-labelledby="best-heading"></div>
      <h2 id="best-heading">Best</h2>
    `;

    const reports = sink();
    const panel = createScorePanel({ document, reporter: reports.reporter });

    panel.update({ score: 5, bestScore: '99' });

    // NO LABEL NODE ADDED: the outlet already has an accessible name, and a
    // second one would be read alongside it.
    expect(outlet('.score-container').querySelector('.visually-hidden')).toBe(
      null,
    );
    expect(outlet('.best-container').querySelector('.visually-hidden')).toBe(
      null,
    );
    expect(valueText(outlet('.score-container'))).toBe('5');
    expect(valueText(outlet('.best-container'))).toBe('99');

    expect(reports.countOf('ui.scorePanel.label_declared')).toBe(2);
    expect(reports.countOf('ui.scorePanel.label_added')).toBe(0);

    panel.destroy();

    // The declared names are untouched.
    expect(outlet('.score-container').getAttribute('aria-label')).toBe(
      'Current score',
    );
    expect(outlet('.best-container').getAttribute('aria-labelledby')).toBe(
      'best-heading',
    );
  });

  it('ignores an empty labelling attribute and creates its own name', () => {
    // A whitespace-only attribute is not a name, so it must not suppress one.
    document.body.innerHTML = `
      <div class="score-container" aria-label="   "></div>
      <div class="best-container" aria-labelledby=""></div>
    `;

    const reports = sink();
    const panel = createScorePanel({ document, reporter: reports.reporter });

    panel.update({ score: 1, bestScore: '2' });

    expect(
      outlet('.score-container').querySelector('.visually-hidden')
        ?.textContent,
    ).toBe('Score');
    expect(
      outlet('.best-container').querySelector('.visually-hidden')?.textContent,
    ).toBe('Best');
    expect(reports.countOf('ui.scorePanel.label_added')).toBe(2);

    panel.destroy();
  });

  it('re-inserts the name it created on every write', () => {
    // A write CLEARS the outlet — js/html_actuator.js L107 — so a name that was
    // not re-inserted would survive exactly one write.
    document.body.innerHTML = BARE_MARKUP;

    const panel = createScorePanel({ document });
    const score = outlet('.score-container');

    for (const value of [4, 8, 16]) {
      panel.updateScore(value);

      expect(score.querySelectorAll('.visually-hidden')).toHaveLength(1);
      expect(valueText(score)).toBe(`Score${String(value)}`);
    }

    panel.destroy();
  });

  it('removes only the name it created, and leaves the value text', () => {
    document.body.innerHTML = BARE_MARKUP;

    const panel = createScorePanel({ document });

    panel.update({ score: 64, bestScore: '128' });
    panel.destroy();

    // The label this component made is gone; the values it wrote remain, so a
    // destroyed panel leaves the last score on screen rather than blanking it.
    expect(outlet('.score-container').querySelector('.visually-hidden')).toBe(
      null,
    );
    expect(outlet('.score-container').textContent).toBe('64');
    expect(outlet('.best-container').textContent).toBe('128');
  });
});

describe('an outlet the document does not supply', () => {
  it('reports each absent outlet and keeps the other working', () => {
    // Only the best-score outlet exists, which is the state a partially updated
    // markup file leaves. The panel must not throw and must not stop writing
    // the outlet it did find — none of the eight selectors this product
    // inherited was null-checked at all.
    document.body.innerHTML = '<div class="best-container"></div>';

    const reports = sink();
    const panel = createScorePanel({ document, reporter: reports.reporter });

    expect(panel.isReady()).toBe(false);
    expect(() => {
      panel.update({ score: 10, bestScore: '20' });
    }).not.toThrow();

    // THE ONE THAT EXISTS IS WRITTEN.
    expect(valueText(outlet('.best-container'))).toBe('Best20');

    // AND THE ABSENCE IS REPORTED, once, naming the mount.
    expect(reports.countOf('ui.scorePanel.mount_missing')).toBe(1);
    expect(
      reports.counts.find(
        (entry): boolean => entry.name === 'ui.scorePanel.mount_missing',
      )?.fields,
    ).toEqual({ mount: 'score', selector: '.score-container' });
    expect(
      reports.warnings.some((message): boolean =>
        message.includes('.score-container'),
      ),
    ).toBe(true);

    panel.destroy();
  });

  it('skips the write and the delta for an absent outlet', () => {
    document.body.innerHTML = '<div class="best-container"></div>';

    const reports = sink();
    const panel = createScorePanel({ document, reporter: reports.reporter });

    // A rising score would append a `.score-addition` inside the score outlet,
    // and there is no outlet to append it to.
    panel.updateScore(30);

    expect(reports.countOf('ui.scorePanel.delta_skipped')).toBe(1);
    expect(reports.countOf('ui.scorePanel.delta_shown')).toBe(0);
    expect(document.querySelector('.score-addition')).toBe(null);

    panel.destroy();
  });

  it('mounts, writes and destroys with neither outlet present', () => {
    document.body.innerHTML = '<div></div>';

    const reports = sink();
    const panel = createScorePanel({ document, reporter: reports.reporter });

    expect(panel.isReady()).toBe(false);
    expect(() => {
      panel.update({ score: 1, bestScore: '1' });
      panel.updateScore(2);
      panel.updateBestScore('3');
      panel.destroy();
    }).not.toThrow();

    expect(reports.countOf('ui.scorePanel.mount_missing')).toBe(2);
    expect(
      reports.counts.find(
        (entry): boolean => entry.name === 'ui.scorePanel.mounted',
      )?.fields,
    ).toEqual({ context: 'score-panel', score: false, best: false });
  });

  it('takes an injected outlet in preference to a lookup', () => {
    // The composition root resolves the outlets itself, so an injected element
    // is used as given rather than re-queried — including one that is not in
    // the document at all.
    document.body.innerHTML = BARE_MARKUP;

    const detached = document.createElement('div');
    const panel = createScorePanel({
      document,
      scoreContainer: detached,
    });

    panel.updateScore(11);

    expect(valueText(detached)).toBe('Score11');

    // The markup's own score outlet was never touched.
    expect(outlet('.score-container').textContent).toBe('');

    panel.destroy();
  });

  it('mounts with no document at all', () => {
    // `document: undefined` and no ambient document is the state a non-browser
    // host leaves. Nothing is looked up, nothing is written, nothing throws.
    const reports = sink();
    const panel = createScorePanel({
      document: undefined,
      scoreContainer: null,
      bestContainer: null,
      reporter: reports.reporter,
    });

    expect(panel.isReady()).toBe(false);
    expect(() => {
      panel.update({ score: 4, bestScore: '4' });
      panel.destroy();
    }).not.toThrow();
    expect(reports.countOf('ui.scorePanel.mount_missing')).toBe(2);
  });
});

describe('a call that reaches a destroyed panel', () => {
  it('is refused and reported rather than writing', () => {
    document.body.innerHTML = BARE_MARKUP;

    const reports = sink();
    const panel = createScorePanel({ document, reporter: reports.reporter });

    panel.update({ score: 5, bestScore: '5' });
    panel.destroy();

    const before = outlet('.score-container').textContent;

    panel.update({ score: 999, bestScore: '999' });
    panel.updateScore(888);
    panel.updateBestScore('777');
    panel.destroy();

    expect(outlet('.score-container').textContent).toBe(before);
    expect(outlet('.best-container').textContent).toBe('5');
    expect(reports.countOf('ui.scorePanel.write_after_destroy')).toBe(4);
  });
});

describe('the rising-score delta', () => {
  it('appends one addition node inside the score outlet, and only on a rise',
    () => {
      document.body.innerHTML = BARE_MARKUP;

      const reports = sink();
      const panel = createScorePanel({ document, reporter: reports.reporter });
      const score = outlet('.score-container');

      panel.updateScore(4);

      const addition = score.querySelector('.score-addition');

      expect(addition).not.toBeNull();
      expect(addition?.textContent).toBe('+4');
      expect(addition?.parentElement).toBe(score);

      // A write that does not raise the score shows no delta, and the previous
      // delta is cleared by the write.
      panel.updateScore(4);

      expect(score.querySelector('.score-addition')).toBe(null);
      expect(score.textContent).toBe('Score4');

      // A fall shows none either.
      panel.updateScore(2);

      expect(score.querySelector('.score-addition')).toBe(null);
      expect(reports.countOf('ui.scorePanel.delta_shown')).toBe(1);

      panel.destroy();
    });

  it('detaches an outstanding delta on destroy', () => {
    document.body.innerHTML = BARE_MARKUP;

    const panel = createScorePanel({ document });
    const score = outlet('.score-container');

    panel.updateScore(8);

    expect(score.querySelector('.score-addition')).not.toBeNull();

    panel.destroy();

    expect(score.querySelector('.score-addition')).toBe(null);
    expect(score.textContent).toBe('8');
  });
});
