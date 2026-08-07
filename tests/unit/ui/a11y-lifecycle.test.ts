// Contract suite for the accessibility layer's lifecycle and announcement
// bounds, AAP R9.
//
// Four properties are pinned here, none of them visible to the type checker:
//
//   remount      the parallel board layer installs a keydown listener on its
//                host and a change listener on a media query. Remounting used
//                to clear the cells only, so the previous host kept both
//                listeners and its attribute-ownership flags were read against
//                the NEXT host — which could strip a `role` it declared itself.
//   receiver     `destroy()` reached `releaseAll` through `this`, so a
//                destructured or re-bound call released the wrong stack, or
//                threw.
//   bounds       the queue bound refused to discard `terminal` and
//                `relicAcquired`, so a queue of nothing but those grew past
//                the bound; and the outbox composed utterances were pushed
//                into had no ceiling at all.
//   assertive    a polite `role="status"` region does not interrupt, so routing
//                an assertive request into it is not an assertive announcement.
//
// The announcer schedules its own flush, so every test here flushes explicitly
// rather than waiting on a timer.

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { createNumberOnlyRenderer } from '../../../src/render/number-only-renderer';
import type { UiReportFields } from '../../../src/ui/a11y/settings';
import {
  createFocusManager,
  createParallelBoardLayer,
} from '../../../src/ui/a11y/focus-manager';
import type { AnnouncerScheduler } from '../../../src/ui/a11y/live-region';
import {
  DEFAULT_MAX_QUEUED_ANNOUNCEMENTS,
  OUTBOX_CAPACITY_MULTIPLE,
  createLiveRegionAnnouncer,
  isGameplayAnnouncementKind,
  isProtectedAnnouncementKind,
} from '../../../src/ui/a11y/live-region';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Collects every report, for assertions on what was said. */
const recorder = (): {
  reporter: {
    log(level: string, message: string, fields?: UiReportFields): void;
    count(metric: string, fields?: UiReportFields): void;
    error(message: string, error: unknown, fields?: UiReportFields): void;
  };
  logs: { level: string; message: string; fields?: UiReportFields }[];
  counts: { metric: string; fields?: UiReportFields }[];
} => {
  const logs: {
    level: string;
    message: string;
    fields?: UiReportFields;
  }[] = [];
  const counts: { metric: string; fields?: UiReportFields }[] = [];

  return {
    reporter: {
      log: (level, message, fields): void => {
        logs.push({ level, message, fields });
      },
      count: (metric, fields): void => {
        counts.push({ metric, fields });
      },
      error: (message, _error, fields): void => {
        logs.push({ level: 'error', message, fields });
      },
    },
    logs,
    counts,
  };
};

/** A bare host for the parallel board layer. */
const boardHost = (id: string): HTMLElement => {
  const host = document.createElement('div');

  host.id = id;
  document.body.appendChild(host);

  return host;
};

/**
 * Runs each scheduled step immediately, so a `flush()` reaches the regions
 * within the call rather than on a later timer.
 */
const syncScheduler =
  (): AnnouncerScheduler =>
  (callback): { cancel(): void } => {
    callback();

    return {
      cancel: (): void => {
        // Already run.
      },
    };
  };

/** Never runs a step, so composed utterances stay in the outbox. */
const frozenScheduler = (): AnnouncerScheduler => (): { cancel(): void } => ({
  cancel: (): void => {
    // Nothing was scheduled.
  },
});

/** A polite live region matching the one index.html declares. */
const politeRegion = (): HTMLElement => {
  const wrapper = document.createElement('div');
  const region = document.createElement('div');

  region.id = 'live-region';
  region.className = 'visually-hidden';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.setAttribute('aria-atomic', 'true');
  wrapper.appendChild(region);
  document.body.appendChild(wrapper);

  return region;
};

/* ===== 1. Remount runs the complete unmount path (F-03) ===== */

describe('the parallel board layer tears down before it remounts', () => {
  it('removes the previous host keydown listener', () => {
    const first = boardHost('board-one');
    const second = boardHost('board-two');
    const activated: string[] = [];

    const layer = createParallelBoardLayer({
      document,
      onActivateCell: (cell): void => {
        activated.push(`${cell.x},${cell.y}`);
      },
    });

    expect(layer.mount(first, 4)).toBe(true);
    expect(layer.mount(second, 4)).toBe(true);

    // The old host would still have carried the listener, so a key pressed on
    // it would have activated a cell of a board no longer mounted.
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );

    expect(activated).toEqual([]);

    layer.unmount();
  });

  it('leaves the previous host free of the attributes it added', () => {
    const first = boardHost('board-one');
    const second = boardHost('board-two');
    const layer = createParallelBoardLayer({ document });

    expect(layer.mount(first, 4)).toBe(true);
    expect(first.getAttribute('role')).toBe('grid');
    expect(first.getAttribute('tabindex')).toBe('0');

    expect(layer.mount(second, 4)).toBe(true);

    expect(first.hasAttribute('role')).toBe(false);
    expect(first.hasAttribute('tabindex')).toBe(false);
    expect(second.getAttribute('role')).toBe('grid');

    layer.unmount();
  });

  it('does not carry ownership of an attribute onto the next host', () => {
    const first = boardHost('board-one');
    const second = boardHost('board-two');

    // The second host declares its own role, so the layer must not claim it and
    // must not strip it on unmount.
    second.setAttribute('role', 'grid');

    const layer = createParallelBoardLayer({ document });

    expect(layer.mount(first, 4)).toBe(true);
    expect(layer.mount(second, 4)).toBe(true);

    layer.unmount();

    expect(second.getAttribute('role')).toBe('grid');
  });

  it('empties the previous host of its cells', () => {
    const first = boardHost('board-one');
    const second = boardHost('board-two');
    const layer = createParallelBoardLayer({ document });

    layer.mount(first, 4);
    expect(first.querySelectorAll('[role="gridcell"]').length).toBe(16);

    layer.mount(second, 4);

    expect(first.querySelectorAll('[role="gridcell"]').length).toBe(0);
    expect(second.querySelectorAll('[role="gridcell"]').length).toBe(16);

    layer.unmount();
  });

  it('reports itself unmounted after a rejected board size', () => {
    const host = boardHost('board-one');
    const layer = createParallelBoardLayer({ document });

    expect(layer.mount(host, 4)).toBe(true);
    expect(layer.mount(host, 0)).toBe(false);

    // Every failure path resets the state, so a rejected mount does not leave a
    // half-mounted layer behind.
    expect(layer.isMounted()).toBe(false);
    expect(layer.boardSize()).toBe(0);
    expect(host.hasAttribute('role')).toBe(false);
    expect(host.querySelectorAll('[role="gridcell"]').length).toBe(0);
  });

  it('reports itself unmounted after an unresolvable host', () => {
    const host = boardHost('board-one');
    const layer = createParallelBoardLayer({ document });

    expect(layer.mount(host, 4)).toBe(true);
    expect(layer.mount('#no-such-host', 4)).toBe(false);

    expect(layer.isMounted()).toBe(false);
    expect(host.hasAttribute('role')).toBe(false);
  });

  it('is safe to unmount more than once', () => {
    const host = boardHost('board-one');
    const layer = createParallelBoardLayer({ document });

    layer.mount(host, 4);
    layer.unmount();

    expect(() => {
      layer.unmount();
    }).not.toThrow();
    expect(layer.isMounted()).toBe(false);
  });

  it('remounts onto the same host cleanly', () => {
    const host = boardHost('board-one');
    const layer = createParallelBoardLayer({ document });

    expect(layer.mount(host, 4)).toBe(true);
    expect(layer.mount(host, 4)).toBe(true);

    // One lattice, not two: the second mount tore the first one down.
    expect(host.querySelectorAll('[role="gridcell"]').length).toBe(16);
    expect(layer.boardSize()).toBe(4);

    layer.unmount();
  });
});

/* ===== 2. destroy() does not depend on a receiver (F-04) ===== */

describe('the focus manager destroys without a receiver', () => {
  it('survives a destructured call', () => {
    const manager = createFocusManager({});
    const { destroy } = manager;

    expect(() => {
      destroy();
    }).not.toThrow();
  });

  it('survives a call re-bound to another object', () => {
    const manager = createFocusManager({});
    const detached = manager.destroy.bind({});

    expect(() => {
      detached();
    }).not.toThrow();
    expect(manager.trapDepth()).toBe(0);
  });

  it('releases this manager, not another object, when detached', () => {
    const manager = createFocusManager({});
    const destroy = manager.destroy;

    destroy();

    // Destroyed for real: a second call is the documented no-op.
    expect(() => {
      manager.destroy();
    }).not.toThrow();
    expect(manager.trapDepth()).toBe(0);
  });

  it('exposes releaseAll as a detachable function too', () => {
    const manager = createFocusManager({});
    const { releaseAll } = manager;

    expect(() => {
      releaseAll();
    }).not.toThrow();
    expect(manager.trapDepth()).toBe(0);

    manager.destroy();
  });
});

/* ===== 3. The bound covers queue and outbox (F-07) ===== */

describe('the announcement bound covers every protected kind', () => {
  it('classifies each kind', () => {
    expect(isProtectedAnnouncementKind('terminal')).toBe(true);
    expect(isProtectedAnnouncementKind('relicAcquired')).toBe(true);
    expect(isProtectedAnnouncementKind('text')).toBe(false);
    expect(isProtectedAnnouncementKind('move')).toBe(false);
    expect(isGameplayAnnouncementKind('move')).toBe(true);
    expect(isGameplayAnnouncementKind('terminal')).toBe(false);
  });

  it('holds a queue of protected kinds within the bound', () => {
    const region = politeRegion();
    const track = recorder();
    const announcer = createLiveRegionAnnouncer({
      region,
      reporter: track.reporter,
      autoFlush: false,
      maxQueued: 4,
    });

    for (let index = 0; index < 20; index += 1) {
      announcer.announce({
        kind: 'relicAcquired',
        name: `Relic ${index}`,
        rarity: 'common',
      });
    }

    // The defect: refusing to discard a protected kind let this reach 20.
    expect(announcer.pending()).toBeLessThanOrEqual(4);

    announcer.destroy();
  });

  it('discards gameplay before protected kinds', () => {
    const region = politeRegion();
    const announcer = createLiveRegionAnnouncer({
      region,
      autoFlush: false,
      maxQueued: 2,
      schedule: syncScheduler(),
    });

    announcer.announce({ kind: 'move', direction: 0, changed: true, score: 4 });
    announcer.announce({ kind: 'move', direction: 1, changed: true, score: 8 });
    announcer.announce({
      kind: 'terminal',
      verdict: 'loss',
    });

    announcer.flush();

    // The terminal verdict survived the pressure; a move did not. It is read
    // out of the assertive region, which is where a verdict now goes.
    const assertive = document.querySelector('[aria-live="assertive"]');

    expect(assertive?.textContent ?? '').toMatch(/over|lost|lose|loss/i);
    expect(region.textContent ?? '').toBe('');

    announcer.destroy();
  });

  it('reports a protected discard separately', () => {
    const region = politeRegion();
    const track = recorder();
    const announcer = createLiveRegionAnnouncer({
      region,
      reporter: track.reporter,
      autoFlush: false,
      maxQueued: 2,
    });

    for (let index = 0; index < 10; index += 1) {
      announcer.announce({
        kind: 'relicAcquired',
        name: `Relic ${index}`,
        rarity: 'rare',
      });
    }

    const protectedDrops = track.counts.filter(
      (entry) => entry.metric === 'ui.liveRegion.dropped.protected',
    );

    expect(protectedDrops.length).toBeGreaterThan(0);

    announcer.destroy();
  });

  it('bounds the outbox as well as the queue', () => {
    const region = politeRegion();
    const track = recorder();
    const capacity = 2;
    const announcer = createLiveRegionAnnouncer({
      region,
      reporter: track.reporter,
      autoFlush: false,
      maxQueued: capacity,
      // No writes are driven, so everything composed stays in the outbox.
      schedule: frozenScheduler(),
    });

    for (let round = 0; round < 40; round += 1) {
      announcer.announce({
        kind: 'relicAcquired',
        name: `Relic ${round}`,
        rarity: 'legendary',
      });
      announcer.flush();
    }

    // The defect: the outbox had no ceiling at all, so this grew to 40.
    expect(announcer.pending()).toBeLessThanOrEqual(
      capacity + capacity * OUTBOX_CAPACITY_MULTIPLE,
    );

    announcer.destroy();
  });

  it('reports what the outbox bound discarded', () => {
    const region = politeRegion();
    const track = recorder();
    const announcer = createLiveRegionAnnouncer({
      region,
      reporter: track.reporter,
      autoFlush: false,
      maxQueued: 2,
      schedule: frozenScheduler(),
    });

    for (let round = 0; round < 40; round += 1) {
      announcer.announce({ kind: 'text', text: `Line ${round}` });
      announcer.flush();
    }

    expect(
      track.counts.some(
        (entry) => entry.metric === 'ui.liveRegion.outbox.dropped',
      ),
    ).toBe(true);

    announcer.destroy();
  });

  it('keeps the default bound within a sane range', () => {
    expect(DEFAULT_MAX_QUEUED_ANNOUNCEMENTS).toBeGreaterThan(0);
    expect(OUTBOX_CAPACITY_MULTIPLE).toBeGreaterThanOrEqual(1);
  });
});

/* ===== 4. Assertive requests are assertive, or reported (F-08) ===== */

describe('an assertive request is not silently made polite', () => {
  it('creates an assertive region beside the polite one', () => {
    const region = politeRegion();
    const announcer = createLiveRegionAnnouncer({
      region,
      autoFlush: false,
      schedule: syncScheduler(),
    });

    announcer.announce({ kind: 'terminal', verdict: 'loss' });
    announcer.flush();

    const created = document.querySelector('[aria-live="assertive"]');

    expect(created).not.toBeNull();
    expect(created?.getAttribute('role')).toBe('alert');
    expect(created?.getAttribute('aria-atomic')).toBe('true');
    expect(created?.classList.contains('visually-hidden')).toBe(true);

    // Beside, not nested: both regions share a parent.
    expect(created?.parentNode).toBe(region.parentNode);

    announcer.destroy();
  });

  it('writes the verdict into the assertive region, not the polite one', () => {
    const region = politeRegion();
    const announcer = createLiveRegionAnnouncer({
      region,
      autoFlush: false,
      schedule: syncScheduler(),
    });

    announcer.announce({ kind: 'terminal', verdict: 'loss' });
    announcer.flush();

    const created = document.querySelector('[aria-live="assertive"]');

    expect((created?.textContent ?? '').length).toBeGreaterThan(0);
    expect(region.textContent ?? '').toBe('');

    announcer.destroy();
  });

  it('counts the region it created', () => {
    const region = politeRegion();
    const track = recorder();
    const announcer = createLiveRegionAnnouncer({
      region,
      reporter: track.reporter,
      autoFlush: false,
      schedule: syncScheduler(),
    });

    announcer.announce({ kind: 'terminal', verdict: 'win' });
    announcer.flush();

    expect(
      track.counts.some(
        (entry) => entry.metric === 'ui.liveRegion.assertive.created',
      ),
    ).toBe(true);

    announcer.destroy();
  });

  it('creates the region once across several assertive announcements', () => {
    const region = politeRegion();
    const announcer = createLiveRegionAnnouncer({
      region,
      autoFlush: false,
      schedule: syncScheduler(),
    });

    for (let round = 0; round < 3; round += 1) {
      announcer.announce({ kind: 'terminal', verdict: 'loss' });
      announcer.flush();
    }

    expect(document.querySelectorAll('[aria-live="assertive"]').length).toBe(1);

    announcer.destroy();
  });

  it('does not create one before an assertive announcement is made', () => {
    const region = politeRegion();
    const announcer = createLiveRegionAnnouncer({
      region,
      autoFlush: false,
      schedule: syncScheduler(),
    });

    announcer.announce({ kind: 'move', direction: 0, changed: true, score: 4 });
    announcer.flush();

    expect(document.querySelector('[aria-live="assertive"]')).toBeNull();

    announcer.destroy();
  });

  it('removes the region it created on destroy', () => {
    const region = politeRegion();
    const announcer = createLiveRegionAnnouncer({
      region,
      autoFlush: false,
      schedule: syncScheduler(),
    });

    announcer.announce({ kind: 'terminal', verdict: 'loss' });
    announcer.flush();

    expect(document.querySelector('[aria-live="assertive"]')).not.toBeNull();

    announcer.destroy();

    expect(document.querySelector('[aria-live="assertive"]')).toBeNull();
  });

  it('leaves a supplied assertive region in place on destroy', () => {
    const region = politeRegion();
    const supplied = document.createElement('div');

    supplied.id = 'assertive-region';
    document.body.appendChild(supplied);

    const announcer = createLiveRegionAnnouncer({
      region,
      assertiveRegion: supplied,
      autoFlush: false,
      schedule: syncScheduler(),
    });

    announcer.announce({ kind: 'terminal', verdict: 'win' });
    announcer.flush();

    expect((supplied.textContent ?? '').length).toBeGreaterThan(0);

    announcer.destroy();

    // Declared by the caller, so it outlives the announcer.
    expect(document.getElementById('assertive-region')).not.toBeNull();
  });

  it('reports the downgrade when no assertive region can be created', () => {
    const track = recorder();
    // A detached region has no parent, so no sibling can be inserted beside it.
    const detached = document.createElement('div');

    detached.setAttribute('role', 'status');
    detached.setAttribute('aria-live', 'polite');

    const announcer = createLiveRegionAnnouncer({
      region: detached,
      reporter: track.reporter,
      autoFlush: false,
      schedule: syncScheduler(),
    });

    announcer.announce({ kind: 'terminal', verdict: 'loss' });
    announcer.flush();

    // Stated, not silent: the request was served politely and said so.
    expect(
      track.counts.some(
        (entry) => entry.metric === 'ui.liveRegion.assertive.downgraded',
      ),
    ).toBe(true);
    expect(
      track.logs.some(
        (entry) =>
          entry.level === 'warn' &&
          entry.message.includes('assertive announcement is being made'),
      ),
    ).toBe(true);

    // And it still reached the polite region rather than being dropped.
    expect((detached.textContent ?? '').length).toBeGreaterThan(0);

    announcer.destroy();
  });

  it('logs the downgrade once but counts every occurrence', () => {
    const track = recorder();
    const detached = document.createElement('div');

    detached.setAttribute('role', 'status');

    const announcer = createLiveRegionAnnouncer({
      region: detached,
      reporter: track.reporter,
      autoFlush: false,
      schedule: syncScheduler(),
    });

    for (let round = 0; round < 3; round += 1) {
      announcer.announce({ kind: 'terminal', verdict: 'loss' });
      announcer.flush();
    }

    const logged = track.logs.filter(
      (entry) =>
        entry.level === 'warn' &&
        entry.message.includes('assertive announcement is being made'),
    );
    const counted = track.counts.filter(
      (entry) => entry.metric === 'ui.liveRegion.assertive.downgraded',
    );

    expect(logged.length).toBe(1);
    expect(counted.length).toBeGreaterThan(1);

    announcer.destroy();
  });
});

describe('a board renderer hands the parallel layer over rather than emptying it', () => {
  it('unmounts the layer through its own api and remounts it on release', () => {
    document.body.innerHTML = `
      <div class="board-host">
        <div class="board-number-only" hidden></div>
        <div class="board-a11y" id="board-a11y" role="grid" aria-busy="true"></div>
      </div>
    `;

    const host = document.querySelector<HTMLElement>('.board-number-only')!;
    const parallelHost = document.querySelector<HTMLElement>('#board-a11y')!;
    const layer = createParallelBoardLayer({
      host: parallelHost,
      document,
    });

    expect(layer.mount(parallelHost, 4)).toBe(true);
    expect(layer.isMounted()).toBe(true);
    expect(layer.cellAt(0, 0)).not.toBeNull();

    const renderer = createNumberOnlyRenderer({
      host,
      config: createDefaultRulesConfig(),
      parallelBoard: parallelHost,
      parallelBoardLayer: layer,
    });

    // Claimed: the element is out of the accessibility tree, and the layer knows
    // it is no longer mounted rather than holding detached cells while
    // `isMounted()` still reports `true`.
    expect(parallelHost.getAttribute('aria-hidden')).toBe('true');
    expect(parallelHost.hidden).toBe(true);
    expect(layer.isMounted()).toBe(false);
    expect(layer.cellAt(0, 0)).toBeNull();

    renderer.unmount();

    // Released: the attributes are restored AND the layer is mounted again, so
    // the surface the next renderer takes over is a populated lattice.
    expect(parallelHost.getAttribute('aria-hidden')).toBeNull();
    expect(parallelHost.hidden).toBe(false);
    expect(layer.isMounted()).toBe(true);
    expect(layer.boardSize()).toBe(4);
    expect(layer.cellAt(0, 0)).not.toBeNull();

    renderer.dispose();
    layer.unmount();
    document.body.innerHTML = '';
  });

  it('leaves foreign children in place when no layer is supplied', () => {
    document.body.innerHTML = `
      <div class="board-host">
        <div class="board-number-only" hidden></div>
        <div class="board-a11y" id="board-a11y" role="grid"></div>
      </div>
    `;

    const host = document.querySelector<HTMLElement>('.board-number-only')!;
    const parallelHost = document.querySelector<HTMLElement>('#board-a11y')!;
    const owned = document.createElement('div');

    owned.setAttribute('role', 'gridcell');
    parallelHost.appendChild(owned);

    const renderer = createNumberOnlyRenderer({
      host,
      config: createDefaultRulesConfig(),
      parallelBoard: parallelHost,
    });

    // Hiding is what takes the subtree out of the accessibility tree; nothing
    // has to be removed, and removing it destroyed another component's state.
    expect(parallelHost.hidden).toBe(true);
    expect(parallelHost.contains(owned)).toBe(true);

    renderer.dispose();
    document.body.innerHTML = '';
  });
});
