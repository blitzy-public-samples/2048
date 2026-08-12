// Contract suite for the accessibility layer's lifecycle and announcement
// bounds, AAP R9.
//
// Four properties are pinned here, none of them visible to the type checker.

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { createNumberOnlyRenderer } from '../../../src/render/number-only-renderer';
import type {
  InitialUiPreferences,
  UiReportFields,
  UiReporter,
} from '../../../src/ui/a11y/settings';
import {
  PREFERENCES_SCHEMA_VERSION,
  createPreferenceStore,
  deserializePreferences,
  serializePreferences,
} from '../../../src/ui/a11y/settings';
import {
  SCREEN_INITIAL_FOCUS,
  createFocusManager,
  createParallelBoardLayer,
  focusInitial,
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

    // The second host declares its own role, so the layer must not claim it
    // and must not strip it on unmount.
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

    // Every failure path resets the state, so a rejected mount does not leave
    // a half-mounted layer behind.
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

describe('the restore target a focus trap records', () => {
  /** Collects every warn record and counter a manager reports. */
  const createRecorder = (): {
    warnings: string[];
    counters: string[];
    reporter: UiReporter;
  } => {
    const warnings: string[] = [];
    const counters: string[] = [];

    return {
      warnings,
      counters,
      reporter: {
        log: (level, message): void => {
          if (level === 'warn') {
            warnings.push(message);
          }
        },
        count: (name): void => {
          counters.push(name);
        },
        error: (message): void => {
          warnings.push(message);
        },
      },
    };
  };

  it('skips the document body, and reports it as a state rather than a fault', () => {
    document.body.innerHTML = `
      <div id="board" tabindex="0">board</div>
      <div id="dialog"><button type="button" id="inside">choose</button></div>
    `;

    const board = document.getElementById('board')!;
    const dialog = document.getElementById('dialog')!;
    const recorder = createRecorder();
    const manager = createFocusManager({ reporter: recorder.reporter });

    // Nothing holds focus, which is what a document reports as its body — and
    // is the ordinary state in a game that binds its keys on the document.
    expect(document.activeElement).toBe(document.body);

    const trap = manager.trap(dialog, {
      label: 'reward',
      restoreFocusTo: board,
      reporter: recorder.reporter,
    });

    expect(trap).not.toBeNull();

    trap?.release();

    expect(document.activeElement).toBe(board);

    // And no failure was reported: a body restore target is a state, not a
    // fault, so it is counted and not warned about.
    expect(recorder.warnings).not.toContain(
      'focus trap restore target did not take focus',
    );
    expect(recorder.counters).toContain('ui.focus.trap.restore_body');

    manager.destroy();
  });

  it('still restores to a real element that held focus', () => {
    document.body.innerHTML = `
      <button type="button" id="trigger">settings</button>
      <div id="dialog"><button type="button" id="inside">close</button></div>
    `;

    const trigger = document.getElementById('trigger') as HTMLButtonElement;
    const dialog = document.getElementById('dialog')!;
    const recorder = createRecorder();
    const manager = createFocusManager({ reporter: recorder.reporter });

    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const trap = manager.trap(dialog, {
      label: 'settings',
      reporter: recorder.reporter,
    });

    trap?.release();

    // Unchanged behaviour for the case the recording exists for: focus returns
    // to the control that opened the dialog.
    expect(document.activeElement).toBe(trigger);
    expect(recorder.counters).not.toContain('ui.focus.trap.restore_body');

    manager.destroy();
  });

  it('leaves focus inside the document when nothing was recorded and no fallback was given', () => {
    document.body.innerHTML = `
      <div id="dialog"><button type="button" id="inside">ok</button></div>
    `;

    const dialog = document.getElementById('dialog')!;
    const recorder = createRecorder();
    const manager = createFocusManager({ reporter: recorder.reporter });

    const trap = manager.trap(dialog, {
      label: 'reward',
      reporter: recorder.reporter,
    });

    expect(trap).not.toBeNull();

    // No warning even here: there was nothing to restore to and nothing was
    // promised, so there is nothing to report as broken.
    expect(() => {
      trap?.release();
    }).not.toThrow();
    expect(recorder.warnings).not.toContain(
      'focus trap restore target did not take focus',
    );

    manager.destroy();
  });
});

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

    // The terminal verdict survived the pressure; a move did not.
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
    // A detached region has no parent, so no sibling can be inserted beside
    // it.
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

describe('F-05 stage focus resolves the board surface in force', () => {
  /**
   * The game region as index.html declares it: the number-only host first, the
   * parallel board second, both inside the region the router focuses within.
   *
   * @param numberOnlyHoldsLattice Whether the number-only renderer has built a
   *   lattice, which is also when it hides the parallel board.
   * @returns The region and the two candidate tab stops.
   */
  const region = (
    numberOnlyHoldsLattice: boolean,
  ): {
    container: HTMLElement;
    parallel: HTMLElement;
    cells: HTMLElement[];
  } => {
    document.body.innerHTML = `
      <main id="game-main">
        <div id="board-number-only"></div>
        <div id="board-a11y" role="grid" tabindex="0"></div>
      </main>
    `;

    const container = document.querySelector<HTMLElement>('#game-main')!;
    const host = document.querySelector<HTMLElement>('#board-number-only')!;
    const parallel = document.querySelector<HTMLElement>('#board-a11y')!;
    const cells: HTMLElement[] = [];

    if (numberOnlyHoldsLattice) {
      for (let index = 0; index < 4; index += 1) {
        const cell = document.createElement('div');

        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('tabindex', index === 2 ? '0' : '-1');
        host.appendChild(cell);
        cells.push(cell);
      }

      // What `claimParallelBoard()` does: hidden, never emptied.
      parallel.hidden = true;
      parallel.setAttribute('aria-hidden', 'true');
    }

    return { container, parallel, cells };
  };

  it('names the number-only tab stop ahead of the parallel host', () => {
    // Document order decides `querySelector`, and the composition root resolves
    // the same two names in the same order for the reward restore.
    expect(SCREEN_INITIAL_FOCUS.stage).toEqual([
      '#board-number-only [tabindex="0"]',
      '#board-a11y',
    ]);
  });

  it('places stage focus on the lattice cell holding the roving stop', () => {
    const { cells } = region(true);

    const placement = focusInitial('stage', document.querySelector('#game-main'));

    // The DESIGNATED target, not the first focusable element that happens to be
    // in the region: the stop had roved to the third cell, and that is where a
    // returning player resumes reading. DL-FOCUS-04.
    expect(placement.source).toBe('screen-selector');
    expect(placement.element).toBe(cells.at(2));
    expect(document.activeElement).toBe(cells.at(2));
  });

  it('still places stage focus on the parallel host under the Three renderer', () => {
    const { parallel } = region(false);

    const placement = focusInitial('stage', document.querySelector('#game-main'));

    // No lattice, so the first selector matches nothing and the parallel board —
    // the single tab stop that layer publishes — takes it.
    expect(placement.source).toBe('screen-selector');
    expect(placement.element).toBe(parallel);
    expect(document.activeElement).toBe(parallel);
  });
});

/* ==========================================================================
 * `release({ restoreFocus: false })` — for the caller that places focus
 * itself immediately afterwards. DL-FOCUS-05.
 * ========================================================================== */

describe('a trap release can decline the focus restore', () => {
  it('leaves focus where it is and reports no restore failure', () => {
    document.body.innerHTML = `
      <div id="board" tabindex="0">board</div>
      <div id="dialog"><button type="button" id="inside">choose</button></div>
    `;

    const board = document.getElementById('board')!;
    const dialog = document.getElementById('dialog')!;
    const inside = document.getElementById('inside')!;
    const recorded = recorder();
    const manager = createFocusManager({ reporter: recorded.reporter });

    const trap = manager.trap(dialog, {
      label: 'screen',
      restoreFocusTo: board,
      reporter: recorded.reporter,
    });

    expect(trap).not.toBeNull();

    // The trap opened on the dialog's own control.
    expect(document.activeElement).toBe(inside);

    trap?.release({ restoreFocus: false });

    // Focus was NOT pulled back to the recorded target: the caller declared it
    // places focus itself.
    expect(document.activeElement).not.toBe(board);

    const warnings = recorded.logs
      .filter((entry) => entry.level === 'warn')
      .map((entry) => entry.message);

    expect(warnings).not.toContain(
      'focus trap restore target did not take focus',
    );
    expect(warnings).not.toContain(
      'focus trap restore fallback did not take focus',
    );

    manager.destroy();
  });

  it('still restores when the option is omitted or true', () => {
    for (const options of [undefined, { restoreFocus: true }]) {
      document.body.innerHTML = `
        <div id="board" tabindex="0">board</div>
        <div id="dialog"><button type="button" id="inside">choose</button></div>
      `;

      const board = document.getElementById('board')!;
      const dialog = document.getElementById('dialog')!;
      const recorded = recorder();
      const manager = createFocusManager({ reporter: recorded.reporter });
      const trap = manager.trap(dialog, {
        label: 'screen',
        restoreFocusTo: board,
        reporter: recorded.reporter,
      });

      trap?.release(options);

      expect(document.activeElement).toBe(board);

      manager.destroy();
    }
  });

  it('still lifts every inertness it applied', () => {
    document.body.innerHTML = `
      <div id="background">behind</div>
      <div id="dialog"><button type="button" id="inside">choose</button></div>
    `;

    const background = document.getElementById('background')!;
    const dialog = document.getElementById('dialog')!;
    const recorded = recorder();
    const manager = createFocusManager({ reporter: recorded.reporter });
    const trap = manager.trap(dialog, {
      label: 'screen',
      inertBackground: [background],
      reporter: recorded.reporter,
    });

    expect(background.hasAttribute('inert')).toBe(true);

    trap?.release({ restoreFocus: false });

    // Declining the restore does not decline the cleanup.
    expect(background.hasAttribute('inert')).toBe(false);

    manager.destroy();
  });
});

/* ==========================================================================
 * ADDED: `release({ beforeRestore })` — the window between lifting the
 * inertness this trap applied and restoring focus, for the caller whose own
 * presentation layer withholds the restore target while the background is
 * inert. DL-FOCUS-08, and DL-ROUTER-41 for the caller that needs it.
 * ========================================================================== */

describe('a trap release can re-present its restore target first', () => {
  it('invokes the callback after the lift and before the restore', () => {
    document.body.innerHTML = `
      <div id="background"><button type="button" id="trigger" disabled>open</button></div>
      <div id="dialog"><button type="button" id="inside">close</button></div>
    `;

    const background = document.getElementById('background')!;
    const dialog = document.getElementById('dialog')!;
    const trigger = document.getElementById('trigger') as HTMLButtonElement;
    const recorded = recorder();
    const manager = createFocusManager({ reporter: recorded.reporter });

    const trap = manager.trap(dialog, {
      label: 'settings',
      restoreFocusTo: trigger,
      inertBackground: [background],
      reporter: recorded.reporter,
    });

    expect(trap).not.toBeNull();
    expect(background.hasAttribute('inert')).toBe(true);

    // What the on-screen control layer does: the trigger is withheld while its
    // host is inert, and is re-presented once the host is interactive again.
    const observed: { inert: boolean; active: string | null }[] = [];

    trap?.release({
      beforeRestore: (): void => {
        observed.push({
          inert: background.hasAttribute('inert'),
          active: document.activeElement?.id ?? null,
        });

        trigger.disabled = false;
      },
    });

    // Called exactly once, with the inertness already lifted and focus not yet
    // moved off the dialog's own control.
    expect(observed).toEqual([{ inert: false, active: 'inside' }]);

    // And because the callback re-presented it, the restore landed.
    expect(document.activeElement).toBe(trigger);

    const warnings = recorded.logs
      .filter((entry) => entry.level === 'warn')
      .map((entry) => entry.message);

    expect(warnings).not.toContain(
      'focus trap restore target did not take focus',
    );

    manager.destroy();
  });

  it('reports a throwing callback and completes the release anyway', () => {
    document.body.innerHTML = `
      <div id="background"><button type="button" id="trigger">open</button></div>
      <div id="dialog"><button type="button" id="inside">close</button></div>
    `;

    const background = document.getElementById('background')!;
    const dialog = document.getElementById('dialog')!;
    const trigger = document.getElementById('trigger')!;
    const recorded = recorder();
    const manager = createFocusManager({ reporter: recorded.reporter });

    const trap = manager.trap(dialog, {
      label: 'settings',
      restoreFocusTo: trigger,
      inertBackground: [background],
      reporter: recorded.reporter,
    });

    trap?.release({
      beforeRestore: (): void => {
        throw new Error('presentation layer failed');
      },
    });

    // The release finished: inertness lifted, focus restored, trap inactive.
    expect(background.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(trap?.isActive()).toBe(false);

    // And the failure was reported rather than swallowed.
    expect(
      recorded.logs.filter(
        (entry) =>
          entry.level === 'error' &&
          entry.message === 'focus trap release callback threw',
      ),
    ).toHaveLength(1);

    manager.destroy();
  });
});

/* ==========================================================================
 * Both board layers name a cell row first. DL-FOCUS-06.
 * ========================================================================== */

describe('the two board layers agree on axis order', () => {
  it('names a parallel-board cell row first, then column', () => {
    const host = boardHost('board-axis-order');
    const layer = createParallelBoardLayer({ document });

    expect(layer.mount(host, 4)).toBe(true);

    layer.update([{ x: 0, y: 0, value: 2 }]);

    const labels = [...host.querySelectorAll('[role="gridcell"]')].map(
      (cell) => cell.getAttribute('aria-label') ?? '',
    );

    // Sixteen cells, every one named row first — the order
    // `numberOnlyRendererCopy` already used. DL-FOCUS-06.
    expect(labels).toHaveLength(16);

    for (const label of labels) {
      expect(label).toMatch(/^Row \d+, column \d+, /u);
      expect(label.startsWith('Column ')).toBe(false);
    }

    // And the cell holding the 2 is named as row 1, column 1.
    expect(labels[0]).toBe('Row 1, column 1, 2');

    layer.unmount();
  });
});


/* ==========================================================================
 * Preference persistence — Issue 15 of the QA report: none of the five
 * accessibility and presentation preferences survived a reload, because no
 * storage key existed for them. The pure pair either side of the envelope is
 * what the composition root reads and writes. DL-SETTINGS-06, DL-KEYS-04.
 * ========================================================================== */

describe('the persisted preference envelope', () => {
  /** A store with no platform motion query, so the setting alone governs. */
  const store = (
    initial?: InitialUiPreferences,
  ): ReturnType<typeof createPreferenceStore> =>
    createPreferenceStore({
      motionSource: null,
      // The palette must not be written onto this document by a unit test.
      activateTheme: (): void => {
        return;
      },
      ...(initial === undefined ? {} : { initial }),
    });

  it('carries a version, so a later shape change is detectable at load', () => {
    const payload = serializePreferences(store().getPreferences());

    expect(payload.schemaVersion).toBe(PREFERENCES_SCHEMA_VERSION);
    expect(PREFERENCES_SCHEMA_VERSION).toBe(1);
  });

  it('round-trips all five preferences through JSON', () => {
    const written = store({
      motionSetting: 'reduce',
      theme: 'high-contrast',
      numberOnlyMode: true,
      muted: true,
      volume: 0.5,
    });

    const restored = store(
      deserializePreferences(
        JSON.parse(JSON.stringify(serializePreferences(written.getPreferences()))),
      ),
    );

    expect(restored.getMotionSetting()).toBe('reduce');
    expect(restored.getTheme()).toBe('high-contrast');
    expect(restored.isNumberOnlyMode()).toBe(true);
    expect(restored.isMuted()).toBe(true);
    expect(restored.getVolume()).toBe(0.5);
  });

  it('records the number-only CHOICE, never a platform-imposed force', () => {
    const chosen = store();

    // No choice made; the platform imposes the mode.
    chosen.forceNumberOnlyMode('WebGL is unavailable');

    expect(chosen.isNumberOnlyMode()).toBe(true);
    expect(chosen.isNumberOnlyForced()).toBe(true);

    // The envelope records what the PLAYER expressed, which is nothing — so a
    // later session on a working machine does not open in number-only mode.
    expect(serializePreferences(chosen.getPreferences()).numberOnlyMode).toBe(
      false,
    );

    const next = store(
      deserializePreferences(serializePreferences(chosen.getPreferences())),
    );

    expect(next.isNumberOnlyMode()).toBe(false);
    expect(next.isNumberOnlyForced()).toBe(false);
  });

  it('records a deliberate number-only choice', () => {
    const chosen = store();

    chosen.setNumberOnlyMode(true);

    expect(serializePreferences(chosen.getPreferences()).numberOnlyMode).toBe(
      true,
    );
  });

  it('yields the defaults for a payload of the wrong shape, without throwing', () => {
    for (const hostile of [
      null,
      undefined,
      42,
      'high-contrast',
      true,
      [],
      [{ theme: 'high-contrast' }],
    ] as const) {
      expect(() => deserializePreferences(hostile)).not.toThrow();
      expect(deserializePreferences(hostile)).toStrictEqual({});
    }
  });

  it('refuses a version it cannot read, whole', () => {
    for (const version of [0, 2, '1', null, undefined, Number.NaN]) {
      const payload = {
        ...serializePreferences(
          store({ theme: 'colorblind-safe', muted: true }).getPreferences(),
        ),
        schemaVersion: version,
      };

      // Every field is readable in isolation; the version alone refuses it.
      expect(deserializePreferences(payload)).toStrictEqual({});
    }
  });

  it('omits a field of the wrong type and keeps the rest', () => {
    const restored = deserializePreferences({
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      motionSetting: 'sideways',
      theme: 'high-contrast',
      numberOnlyMode: 'yes',
      muted: 1,
      volume: 'loud',
    });

    expect(restored).toStrictEqual({ theme: 'high-contrast' });
    expect(store(restored).getTheme()).toBe('high-contrast');
    expect(store(restored).getMotionSetting()).toBe('system');
  });

  it('hands an out-of-range volume through so the store clamps it', () => {
    const restored = deserializePreferences({
      schemaVersion: PREFERENCES_SCHEMA_VERSION,
      volume: 4,
    });

    // Not dropped for the default — handed through and repaired.
    expect(restored).toStrictEqual({ volume: 4 });
    expect(store(restored).getVolume()).toBe(1);

    // A non-finite figure is not a volume at all and is omitted.
    expect(
      deserializePreferences({
        schemaVersion: PREFERENCES_SCHEMA_VERSION,
        volume: Number.POSITIVE_INFINITY,
      }),
    ).toStrictEqual({});
  });

  it('reports what it refused through the injected sink', () => {
    const levels: string[] = [];
    const counters: string[] = [];
    const sink: UiReporter = {
      log: (level: string): void => {
        levels.push(level);
      },
      count: (name: string): void => {
        counters.push(name);
      },
      error: (): void => {
        return;
      },
    };

    deserializePreferences('not an object', sink);
    deserializePreferences({ schemaVersion: 99 }, sink);
    deserializePreferences(
      { schemaVersion: PREFERENCES_SCHEMA_VERSION, theme: 'neon' },
      sink,
    );

    expect(levels).toStrictEqual(['warn', 'warn', 'warn']);
    expect(counters).toStrictEqual([
      'ui.preferences.payload_rejected',
      'ui.preferences.payload_rejected',
      'ui.preferences.payload_field_rejected',
    ]);
  });

  it('says nothing for a payload it read completely', () => {
    const levels: string[] = [];
    const sink: UiReporter = {
      log: (level: string): void => {
        levels.push(level);
      },
      count: (): void => {
        return;
      },
      error: (): void => {
        return;
      },
    };

    deserializePreferences(
      serializePreferences(
        store({ theme: 'colorblind-safe', motionSetting: 'allow' }).getPreferences(),
      ),
      sink,
    );

    expect(levels).toStrictEqual([]);
  });
});
