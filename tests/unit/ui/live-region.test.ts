// Queue-bound suite of src/ui/a11y/live-region.ts.
//
// The invariant under test is the one `LiveRegionAnnouncerOptions.maxQueued`
// states: "the queue never holds more than this many, whatever kinds they
// are". The bound is structural, so a run of `terminal` and `relicAcquired`
// announcements — the two kinds the eviction tiers protect longest — cannot
// carry the queue past it.
//
// Sections:
//   1  the bound holds under every sequence of kinds
//   2  the eviction tiers, so the bound keeps the semantics it protects
//   3  the drop report, so a discarded announcement is diagnosable
//
// Auto-flush is switched off throughout section 1 and 2 with an explicit
// `autoFlush: false`, so `pending()` measures the queue rather than a queue
// racing a scheduled flush. Section 3 flushes by hand.
//
// The region is the one index.html L105 declares. The reporter is a
// hand-written recorder: no mocking library, no spy on a global, no storage.
// This suite is collected by the `unit:dom` project of vitest.config.ts,
// whose environment is 'jsdom'.
//
// Rationale for the decisions behind this file: docs/DECISION_LOG.md.

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_QUEUED_ANNOUNCEMENTS,
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

/* ===== Doubles and fixtures ===== */

/** One report the recorder kept. */
interface Report {
  readonly metric: string;
  readonly fields: UiReportFields | undefined;
}

/** A reporter that records rather than discarding. */
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

/* ===== 1. The bound holds under every sequence of kinds ===== */

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

/* ===== 2. The eviction tiers ===== */

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

    // The relic line and the LAST verdict survived, which is the verdict
    // `composeAnnouncements` would have composed in any case.
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

/* ===== 3. The drop report ===== */

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
