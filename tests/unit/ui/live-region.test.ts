// Queue-bound suite of src/ui/a11y/live-region.ts.
//
// Sections: 1 the bound holds under every sequence of kinds 2 the eviction
// tiers, so the bound keeps the semantics it protects 3 the drop report, so a
// discarded announcement is diagnosable
//
// The region is the one index.html L105 declares. The reporter is a
// hand-written recorder: no mocking library, no spy on a global, no storage.
// This suite is collected by the `unit:dom` project of vitest.config.ts, whose
// environment is 'jsdom'.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_QUEUED_ANNOUNCEMENTS,
  composeAnnouncements,
  createLiveRegionAnnouncer,
} from '../../../src/ui/a11y/live-region';
import type {
  Announcement,
  LiveRegionAnnouncer,
  LiveRegionAnnouncerOptions,
} from '../../../src/ui/a11y/live-region';
import type {
  UiReportFields,
  UiReportLevel,
  UiReporter,
} from '../../../src/ui/a11y/settings';

/** One report the recorder kept. */
interface Report {
  readonly metric: string;
  readonly fields: UiReportFields | undefined;
}

function createRecorder(): UiReporter & {
  readonly counts: Report[];
  readonly logs: { level: UiReportLevel; fields?: UiReportFields }[];
} {
  const counts: Report[] = [];
  const logs: { level: UiReportLevel; fields?: UiReportFields }[] = [];

  return {
    counts,
    logs,

    log(level: UiReportLevel, _message: string, fields?: UiReportFields): void {
      logs.push({ level, fields });
    },

    count(metric: string, fields?: UiReportFields): void {
      counts.push({ metric, fields });
    },

    error(): void {
      return;
    },
  };
}

/** Every announcer built, destroyed after each test. */
const built: LiveRegionAnnouncer[] = [];

/** The announcer region index.html L105 declares. */
function seedRegion(): void {
  document.body.innerHTML =
    '<div class="visually-hidden live-region" id="live-region" ' +
    'role="status" aria-live="polite" aria-atomic="true"></div>';
}

/**
 * Builds an announcer over the seeded region with auto-flush off.
 *
 * @param options Options to merge over the defaults.
 * @returns The announcer.
 */
function announcer(
  options: Partial<LiveRegionAnnouncerOptions> = {},
): LiveRegionAnnouncer {
  const instance = createLiveRegionAnnouncer({
    autoFlush: false,
    ...options,
  });

  built.push(instance);

  return instance;
}

/** One verdict announcement. */
function terminal(score: number): Announcement {
  return { kind: 'terminal', verdict: 'loss', score };
}

/** One relic-acquisition announcement. */
function relic(name: string): Announcement {
  return { kind: 'relicAcquired', name, rarity: 'common' };
}

afterEach(() => {
  for (const instance of built.splice(0, built.length)) {
    instance.destroy();
  }

  document.body.innerHTML = '';
});

describe('the queue bound is structural', () => {
  it('holds under repeated terminal announcements', () => {
    seedRegion();

    const region = announcer({ maxQueued: 4 });

    for (let index = 0; index < 200; index += 1) {
      region.announce(terminal(index));

      expect(region.pending()).toBeLessThanOrEqual(4);
    }

    expect(region.pending()).toBe(4);
  });

  it('holds under repeated relic acquisitions', () => {
    seedRegion();

    const region = announcer({ maxQueued: 3 });

    for (let index = 0; index < 200; index += 1) {
      region.announce(relic(`relic-${index}`));

      expect(region.pending()).toBeLessThanOrEqual(3);
    }

    expect(region.pending()).toBe(3);
  });

  it('holds under an alternating terminal and relic sequence', () => {
    seedRegion();

    const region = announcer({ maxQueued: 5 });

    for (let index = 0; index < 300; index += 1) {
      region.announce(index % 2 === 0 ? terminal(index) : relic(`r-${index}`));

      expect(region.pending()).toBeLessThanOrEqual(5);
    }
  });

  it('holds under every kind interleaved', () => {
    seedRegion();

    const region = announcer({ maxQueued: 6 });
    const sequence: Announcement[] = [
      { kind: 'move', direction: 0, changed: true, score: 4 },
      { kind: 'merge', resultValue: 4, scoreDelta: 4 },
      { kind: 'spawn', value: 2, position: { x: 1, y: 1 } },
      { kind: 'stageClear', stageIndex: 0, cleared: true },
      relic('compounding-core'),
      terminal(120),
      { kind: 'text', text: 'Settings opened' },
    ];

    for (let round = 0; round < 60; round += 1) {
      for (const item of sequence) {
        region.announce(item);

        expect(region.pending()).toBeLessThanOrEqual(6);
      }
    }
  });

  it('holds at a bound of one', () => {
    seedRegion();

    const region = announcer({ maxQueued: 1 });

    region.announce(terminal(1));
    region.announce(relic('a'));
    region.announce(terminal(2));
    region.announce(relic('b'));

    expect(region.pending()).toBe(1);
  });

  it('holds at the default bound', () => {
    seedRegion();

    const region = announcer();

    for (let index = 0; index < 400; index += 1) {
      region.announce(terminal(index));
    }

    expect(region.pending()).toBe(DEFAULT_MAX_QUEUED_ANNOUNCEMENTS);
  });

  it('holds when free text is the only unprotected kind left', () => {
    seedRegion();

    const region = announcer({ maxQueued: 2 });

    region.announce(relic('a'));
    region.announce({ kind: 'text', text: 'one' });
    region.announce({ kind: 'text', text: 'two' });
    region.announce({ kind: 'text', text: 'three' });

    expect(region.pending()).toBe(2);
  });
});

describe('the bound discards in tiers, gameplay first', () => {
  it('discards a gameplay item before free text', () => {
    seedRegion();

    const region = announcer({ maxQueued: 2 });

    region.announce({ kind: 'move', direction: 1, changed: true, score: 2 });
    region.announce({ kind: 'text', text: 'kept' });
    region.announce(relic('kept-relic'));
    region.flush();

    const written = region.pending();

    // The move went; the text and the relic became the two lines.
    expect(written).toBe(2);
  });

  it('discards free text before a protected kind', () => {
    seedRegion();

    const region = announcer({ maxQueued: 2 });

    region.announce({ kind: 'text', text: 'dropped' });
    region.announce(relic('kept-relic'));
    region.announce(terminal(99));
    region.flush();

    // Two lines: the relic, then the verdict. The text was the victim.
    expect(region.pending()).toBe(2);
  });

  it('discards a superseded verdict before a relic', () => {
    seedRegion();

    const recorder = createRecorder();
    const region = announcer({ maxQueued: 2, reporter: recorder });

    region.announce(terminal(1));
    region.announce(relic('kept-relic'));
    region.announce(terminal(2));

    const dropped = recorder.counts.filter(
      (report) => report.metric === 'ui.liveRegion.dropped',
    );

    expect(region.pending()).toBe(2);
    expect(dropped.length).toBe(1);
    expect(dropped[0].fields?.protected).toBe(1);

    region.flush();

    expect(region.pending()).toBe(2);
  });

  it('keeps the newest relic when relics saturate the bound', () => {
    seedRegion();

    const region = announcer({ maxQueued: 2 });

    region.announce(relic('first'));
    region.announce(relic('second'));
    region.announce(relic('third'));
    region.flush();

    expect(region.pending()).toBe(2);
  });

  it('leaves a queue within its bound untouched', () => {
    seedRegion();

    const recorder = createRecorder();
    const region = announcer({ maxQueued: 8, reporter: recorder });

    region.announce(terminal(1));
    region.announce(relic('a'));
    region.announce({ kind: 'text', text: 'b' });

    expect(region.pending()).toBe(3);
    expect(
      recorder.counts.some(
        (report) => report.metric === 'ui.liveRegion.dropped',
      ),
    ).toBe(false);
  });
});

describe('a discarded announcement is reported, never silent', () => {
  it('counts the drop and how many of them were protected', () => {
    seedRegion();

    const recorder = createRecorder();
    const region = announcer({ maxQueued: 1, reporter: recorder });

    region.announce({ kind: 'move', direction: 0, changed: true, score: 2 });
    region.announce(relic('a'));
    region.announce(relic('b'));

    const dropped = recorder.counts.filter(
      (report) => report.metric === 'ui.liveRegion.dropped',
    );

    expect(dropped.length).toBe(2);
    expect(dropped[0].fields).toMatchObject({ dropped: 1, protected: 0 });
    expect(dropped[1].fields).toMatchObject({ dropped: 1, protected: 1 });
    expect(region.pending()).toBe(1);
  });

  it('logs the drop at warn level with the bound', () => {
    seedRegion();

    const recorder = createRecorder();
    const region = announcer({ maxQueued: 1, reporter: recorder });

    region.announce(terminal(1));
    region.announce(terminal(2));

    const warned = recorder.logs.filter((entry) => entry.level === 'warn');

    expect(warned.length).toBe(1);
    expect(warned[0].fields).toMatchObject({ capacity: 1, protected: 1 });
  });

  it('rejects a bound that is not a positive integer and reports it', () => {
    seedRegion();

    const recorder = createRecorder();
    const region = announcer({ maxQueued: 0, reporter: recorder });

    for (let index = 0; index < 40; index += 1) {
      region.announce(terminal(index));
    }

    expect(region.pending()).toBe(DEFAULT_MAX_QUEUED_ANNOUNCEMENTS);
    expect(
      recorder.counts.some(
        (report) => report.metric === 'ui.liveRegion.capacity.rejected',
      ),
    ).toBe(true);
  });

  it('stays bounded and reports with no region to write to', () => {
    document.body.innerHTML = '';

    const recorder = createRecorder();
    const region = announcer({ maxQueued: 2, reporter: recorder });

    for (let index = 0; index < 50; index += 1) {
      region.announce(terminal(index));
    }

    expect(region.isEnabled()).toBe(false);
    expect(region.pending()).toBe(0);
    expect(
      recorder.counts.some(
        (report) => report.metric === 'ui.liveRegion.host.missing',
      ),
    ).toBe(true);
  });

  it('empties the queue on clear and on destroy', () => {
    seedRegion();

    const region = announcer({ maxQueued: 4 });

    region.announce(terminal(1));
    region.announce(relic('a'));

    expect(region.pending()).toBe(2);

    region.clear();

    expect(region.pending()).toBe(0);

    region.announce(terminal(2));
    region.destroy();

    expect(region.pending()).toBe(0);
  });
});

/* ==========================================================================
 * A relic acquisition outlives free text in its own batch (DL-LIVE-05), and
 * the assertive region can be blanked on its own (DL-LIVE-06).
 * ========================================================================== */

/** The polite and assertive regions index.html declares, both mounted. */
function seedBothRegions(): void {
  document.body.innerHTML =
    '<div class="visually-hidden live-region" id="live-region" ' +
    'role="status" aria-live="polite" aria-atomic="true"></div>' +
    '<div class="visually-hidden live-region" id="live-region-assertive" ' +
    'role="alert" aria-live="assertive" aria-atomic="true"></div>';
}

describe('a relic acquisition is the line a batch is left holding', () => {
  it('composes the pickup AFTER free text queued alongside it', () => {
    const composition = composeAnnouncements([
      relic('Frostbind'),
      { kind: 'text', text: 'Stage 2.' },
    ]);
    const lines = composition.utterances.map((utterance) => utterance.text);

    // Each utterance is written on its own tick with a clear-then-write, so the
    // LAST line is the one the region is left holding. It must be the pickup.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('Stage 2.');
    expect(lines[lines.length - 1]).toContain('Frostbind');
  });

  it('composes it last whichever order the two arrived in', () => {
    const forwards = composeAnnouncements([
      { kind: 'text', text: 'Stage 2.' },
      relic('Frostbind'),
    ]);
    const backwards = composeAnnouncements([
      relic('Frostbind'),
      { kind: 'text', text: 'Stage 2.' },
    ]);

    expect(forwards.utterances.map((u) => u.text)).toEqual(
      backwards.utterances.map((u) => u.text),
    );
  });

  it('still lets a verdict have the final assertive word', () => {
    const composition = composeAnnouncements([
      relic('Frostbind'),
      terminal(1234),
    ]);
    const last = composition.utterances[composition.utterances.length - 1];

    expect(last?.polarity).toBe('assertive');
    expect(last?.text).toContain('1234');
  });
});

describe('the assertive region can be blanked on its own', () => {
  it('clears the verdict and leaves the polite region standing', () => {
    seedBothRegions();

    // An immediate scheduler, so every clear-then-write step runs on the spot
    // and the regions hold their final text by the time `flush()` returns.
    const region = announcer({
      assertiveSelector: '#live-region-assertive',
      schedule: (callback): { cancel(): void } => {
        callback();

        return {
          cancel: (): void => {
            // Already run.
          },
        };
      },
    });
    const polite = document.querySelector('#live-region');
    const assertive = document.querySelector('#live-region-assertive');

    region.announceText('Stage 2.');
    region.announce(terminal(1234));
    region.flush();

    expect(assertive?.textContent ?? '').toContain('1234');

    const politeBefore = polite?.textContent ?? '';

    region.clearAssertive();

    expect(assertive?.textContent).toBe('');
    expect(polite?.textContent ?? '').toBe(politeBefore);
  });

  it('is a safe no-op with no assertive region and after destroy', () => {
    seedRegion();

    const region = announcer();

    expect(() => {
      region.clearAssertive();
    }).not.toThrow();

    region.destroy();

    expect(() => {
      region.clearAssertive();
    }).not.toThrow();
  });
});

/* ==========================================================================
 * ADDED: the withdrawal holds against the DEFERRED scheduler (DL-LIVE-07).
 * Every case above ran its write steps on the spot, so nothing ever sat in the
 * queue or the outbox across the clear — which is exactly where the verdict was
 * surviving it.
 * ========================================================================== */

/** A scheduler whose tasks run only when the test releases them. */
function createManualScheduler(): {
  readonly schedule: (callback: () => void) => { cancel(): void };
  readonly runAll: () => number;
  readonly outstanding: () => number;
} {
  const tasks: (() => void)[] = [];

  return {
    schedule: (callback): { cancel(): void } => {
      const entry = (): void => {
        callback();
      };

      tasks.push(entry);

      return {
        cancel: (): void => {
          const index = tasks.indexOf(entry);

          if (index >= 0) {
            tasks.splice(index, 1);
          }
        },
      };
    },

    // Drains until nothing new is scheduled, because one write step schedules
    // the next.
    runAll: (): number => {
      let ran = 0;

      while (tasks.length > 0) {
        const next = tasks.shift();

        next?.();
        ran += 1;
      }

      return ran;
    },

    outstanding: (): number => tasks.length,
  };
}

describe('withdrawing the alert holds against a deferred scheduler', () => {
  it('never writes a verdict that was queued when the clear arrived', () => {
    seedBothRegions();

    const scheduler = createManualScheduler();
    const region = announcer({
      assertiveSelector: '#live-region-assertive',
      schedule: scheduler.schedule,
    });
    const assertive = document.querySelector('#live-region-assertive');

    // The run ends, and the screen is left before the queue is flushed: the
    // verdict is still an ANNOUNCEMENT, not yet an utterance.
    region.announce(terminal(1234));

    expect(region.pending()).toBe(1);

    region.clearAssertive();

    expect(region.pending()).toBe(0);

    // Everything the announcer had outstanding runs, including the flush the
    // announcement scheduled. The verdict must not reappear.
    region.flush();
    scheduler.runAll();

    expect(assertive?.textContent).toBe('');
  });

  it('never writes a verdict already composed into a pending utterance', () => {
    seedBothRegions();

    const scheduler = createManualScheduler();
    const region = announcer({
      assertiveSelector: '#live-region-assertive',
      schedule: scheduler.schedule,
    });
    const assertive = document.querySelector('#live-region-assertive');

    region.announce(terminal(4321));
    region.flush();

    // Composed and waiting on the write step, which the manual scheduler is
    // holding: the outbox is where the verdict now is.
    expect(region.pending()).toBe(1);
    expect(assertive?.textContent).toBe('');

    region.clearAssertive();
    scheduler.runAll();

    expect(region.pending()).toBe(0);
    expect(assertive?.textContent).toBe('');
  });

  it('resumes the polite batch the withdrawn alert was ahead of', () => {
    seedBothRegions();

    const scheduler = createManualScheduler();
    const region = announcer({
      assertiveSelector: '#live-region-assertive',
      schedule: scheduler.schedule,
    });
    const polite = document.querySelector('#live-region');
    const assertive = document.querySelector('#live-region-assertive');

    // Two lines in one batch: the free text is composed first and the verdict
    // last, so the verdict is behind a polite utterance in the outbox.
    region.announceText('Run start.');
    region.announce(terminal(99));
    region.flush();

    expect(region.pending()).toBe(2);

    region.clearAssertive();
    scheduler.runAll();

    // The polite line still speaks — `clear()` would have discarded it — and
    // the alert region stays empty.
    expect(polite?.textContent).toBe('Run start.');
    expect(assertive?.textContent).toBe('');
    expect(region.pending()).toBe(0);
  });

  it('leaves an assertive line queued AFTER the clear free to speak', () => {
    seedBothRegions();

    const scheduler = createManualScheduler();
    const region = announcer({
      assertiveSelector: '#live-region-assertive',
      schedule: scheduler.schedule,
    });
    const assertive = document.querySelector('#live-region-assertive');

    region.announce(terminal(7));
    region.clearAssertive();

    // A NEW alert, raised after the withdrawal: the withdrawal is not a mute.
    region.announceText('The board renderer fell back.', 'assertive');
    region.flush();
    scheduler.runAll();

    expect(assertive?.textContent).toBe('The board renderer fell back.');
  });

  it('cancels the write step it invalidated and reports what it dropped', () => {
    seedBothRegions();

    const scheduler = createManualScheduler();
    const reporter = createRecorder();
    const region = announcer({
      assertiveSelector: '#live-region-assertive',
      schedule: scheduler.schedule,
      reporter,
    });

    region.announce(terminal(11));
    region.announce({ kind: 'text', text: 'Saved again.' });
    region.flush();

    expect(scheduler.outstanding()).toBeGreaterThan(0);

    region.clearAssertive();

    const cleared = reporter.counts.filter(
      (entry) => entry.metric === 'ui.liveRegion.assertive.cleared',
    );

    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.fields?.queued).toBe(0);
    expect(cleared[0]?.fields?.pending).toBe(1);
    expect(cleared[0]?.fields?.restarted).toBe(true);

    scheduler.runAll();

    expect(document.querySelector('#live-region-assertive')?.textContent).toBe(
      '',
    );
    expect(region.pending()).toBe(0);
  });

  it('counts a withdrawal asked for after destroy as one', () => {
    seedBothRegions();

    const reporter = createRecorder();
    const region = announcer({
      assertiveSelector: '#live-region-assertive',
      reporter,
    });

    region.destroy();
    region.clearAssertive();

    expect(
      reporter.counts.filter(
        (entry) => entry.metric === 'ui.liveRegion.assertive.cleared',
      ),
    ).toEqual([]);
    expect(
      reporter.counts.some(
        (entry) =>
          entry.metric === 'ui.liveRegion.afterDestroy' &&
          entry.fields?.method === 'clearAssertive',
      ),
    ).toBe(true);
  });
});
