// Contract suite for the 2.5D renderer, AAP R1, R7 and R9.
//
// Five properties are pinned here.
//
// The remaining decisions behind this file are recorded in
// docs/DECISION_LOG.md.
//
// Decisions: DL-WEBGL-01 (docs/DECISION_LOG.md).

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { Grid } from '../../../src/engine/grid';
import { Tile } from '../../../src/engine/tile';
import { createEngineEvents } from '../../../src/engine/engine-events';
import type { StateCommitEvent } from '../../../src/engine/engine-events';
import {
  EMPTY_RELIC_CONTEXT,
  EMPTY_STAGE_CONTEXT,
} from '../../../src/engine/types';
import { numberOnlyRendererCopy } from '../../../src/render/number-only-renderer';
import { createThreeRenderer } from '../../../src/render/three-renderer';
import type {
  ContextRestoreOutcome,
  ParallelBoardSurface,
  ThreeRenderer,
} from '../../../src/render/three-renderer';
import { threeRendererCopy } from '../../../src/render/three-renderer';
import type {
  RenderDiagnostic,
  RenderReporter,
} from '../../../src/render/webgl-support';
import { setReducedMotionOverride } from '../../../src/render/webgl-support';
import { createParallelBoardLayer } from '../../../src/ui/a11y/focus-manager';
import { applyTheme } from '../../../src/theme/themes';
import { createMockCanvas, createMockWebGLContext } from '../../fixtures/webgl';

afterEach(() => {
  setReducedMotionOverride(null);
  applyTheme('default');
  document.body.innerHTML = '';
});

interface Placed {
  readonly x: number;
  readonly y: number;
  readonly value: number;
  readonly from?: { readonly x: number; readonly y: number };
  readonly merged?: readonly {
    readonly x: number;
    readonly y: number;
    readonly value: number;
  }[];
}

const commitOf = (
  size: number,
  placed: readonly Placed[],
  score = 0,
): StateCommitEvent => {
  const grid = new Grid(size);

  for (const spec of placed) {
    const tile = new Tile({ x: spec.x, y: spec.y }, spec.value);

    if (spec.from !== undefined) {
      tile.previousPosition = { x: spec.from.x, y: spec.from.y };
    }

    if (spec.merged !== undefined) {
      const [first, second] = spec.merged;

      tile.mergedFrom = [
        new Tile({ x: first.x, y: first.y }, first.value),
        new Tile({ x: second.x, y: second.y }, second.value),
      ];
      tile.mergedFrom[0].previousPosition = { x: first.x, y: first.y };
      tile.mergedFrom[1].previousPosition = { x: second.x, y: second.y };
    }

    grid.insertTile(tile);
  }

  return {
    turn: 1,
    degraded: false,
    board: grid,
    score,
    bestScore: 0,
    over: false,
    won: false,
    terminated: false,
    stage: EMPTY_STAGE_CONTEXT,
    relics: EMPTY_RELIC_CONTEXT,
  };
};

interface Harness {
  readonly renderer: ThreeRenderer;
  readonly canvasElement: HTMLCanvasElement;
  readonly parallelHost: HTMLElement;
  readonly numberOnlyHost: HTMLElement;
  readonly layer: ParallelBoardSurface;
  readonly diagnostics: RenderDiagnostic[];
  readonly counts: { readonly name: string; readonly value: number }[];
  readonly work: () => number;
  readonly countOf: (name: string) => number;

  /** Fires one event on the canvas, which is how a context loss arrives. */
  readonly emit: (type: string) => void;
}

const harness = (
  overrides: {
    readonly context?: unknown;
    readonly withLayer?: boolean;
    readonly boardSize?: number;
  } = {},
): Harness => {
  const numberOnlyHost = document.createElement('div');

  numberOnlyHost.id = 'board-number-only';
  numberOnlyHost.hidden = true;

  const parallelHost = document.createElement('div');

  parallelHost.id = 'board-a11y';
  parallelHost.setAttribute('role', 'grid');
  parallelHost.setAttribute('aria-busy', 'true');

  const mock = createMockCanvas({
    context:
      'context' in overrides ? overrides.context : createMockWebGLContext().gl,
  });

  document.body.append(numberOnlyHost, parallelHost, mock.element);

  const diagnostics: RenderDiagnostic[] = [];
  const counts: { name: string; value: number }[] = [];
  const reporter: RenderReporter = {
    onDiagnostic: (diagnostic): void => {
      diagnostics.push(diagnostic);
    },
    onCount: (count): void => {
      counts.push({ name: count.name, value: count.value });
    },
    onTiming: (): void => {},
  };

  const layer =
    overrides.withLayer === false
      ? null
      : createParallelBoardLayer({ host: parallelHost, document });

  let work = 0;

  const config = createDefaultRulesConfig();
  const renderer = createThreeRenderer({
    canvas: mock.element,
    numberOnlyHost,
    parallelBoard: parallelHost,
    parallelBoardLayer: layer,
    ownerDocument: document,
    config:
      overrides.boardSize === undefined
        ? config
        : { ...config, boardSize: overrides.boardSize },
    reporter,
    onWork: (): void => {
      work += 1;
    },
  });

  return {
    renderer,
    canvasElement: mock.element,
    parallelHost,
    numberOnlyHost,
    layer: layer ?? {
      isMounted: (): boolean => false,
      boardSize: (): number => 0,
      mount: (): boolean => false,
      rebuild: (): boolean => false,
      update: (): void => {},
      unmount: (): void => {},
    },
    diagnostics,
    counts,
    work: (): number => work,
    countOf: (name: string): number =>
      counts
        .filter((entry) => entry.name === name)
        .reduce((total, entry) => total + entry.value, 0),
    emit: (type: string): void => {
      mock.emit(type);
    },
  };
};

/** Steps the renderer until it reports no outstanding work. */
const drain = (renderer: ThreeRenderer, step = 16): number => {
  let frames = 0;

  while (renderer.frame({
    timestamp: frames * step,
    delta: step,
    rawDelta: step,
    deltaClamped: false,
    elapsed: frames * step,
    frame: frames,
  }) && frames < 64) {
    frames += 1;
  }

  return frames;
};

describe('the WebGL prerequisite', () => {
  it('mounts at construction when a canvas yields a context', () => {
    const fixture = harness();

    expect(fixture.renderer.mounted).toBe(true);
    expect(fixture.countOf('render.three.mount')).toBe(1);
    expect(fixture.renderer.readStats().boardSize).toBe(4);
    expect(fixture.renderer.readStats().boardsBuilt).toBe(1);

    fixture.renderer.destroy();
  });

  it('refuses to mount without a canvas, and stays a working no-op', () => {
    const renderer = createThreeRenderer({ ownerDocument: document });

    expect(renderer.mounted).toBe(false);
    expect(renderer.frame()).toBe(false);
    expect(renderer.readRenderedBoard()).toBeNull();
    expect(() => {
      renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    }).not.toThrow();
    expect(renderer.readStats().boardSize).toBe(0);
    expect(() => {
      renderer.destroy();
      renderer.destroy();
    }).not.toThrow();
  });

  it('reports a canvas that yields no context and does not mount', () => {
    const fixture = harness({ context: null });

    expect(fixture.renderer.mounted).toBe(false);
    expect(fixture.countOf('render.three.context.failed')).toBe(1);
    expect(
      fixture.diagnostics.some(
        (diagnostic) =>
          diagnostic.level === 'error' &&
          // The message widened when the mount guard was extended to cover
          // every initialisation step, not only the context and the scene: it
          // now names the whole class of failure it converts into the
          // fallback.
          diagnostic.message.includes('The 2.5D board did not mount'),
      ),
    ).toBe(true);

    fixture.renderer.destroy();
  });

  it('hides the number-only layer while it draws and restores it after', () => {
    const fixture = harness();

    expect(fixture.numberOnlyHost.hidden).toBe(true);
    expect(fixture.canvasElement.hidden).toBe(false);

    fixture.renderer.unmount();

    expect(fixture.numberOnlyHost.hidden).toBe(true);
    expect(fixture.canvasElement.hidden).toBe(true);

    fixture.renderer.destroy();
  });
});

describe('the parallel accessibility board', () => {
  it('mounts the layer rather than claiming it, and exposes the host', () => {
    const fixture = harness();

    expect(fixture.layer.isMounted()).toBe(true);
    expect(fixture.layer.boardSize()).toBe(4);
    expect(fixture.parallelHost.hidden).toBe(false);
    expect(fixture.parallelHost.getAttribute('aria-hidden')).toBeNull();
    expect(fixture.parallelHost.querySelectorAll('[role="gridcell"]')).toHaveLength(
      16,
    );

    fixture.renderer.destroy();
  });

  it('names every cell from the commit it drew', () => {
    const fixture = harness();

    fixture.renderer.render(commitOf(4, [{ x: 1, y: 2, value: 8 }]));
    drain(fixture.renderer);

    const cells = Array.from(
      fixture.parallelHost.querySelectorAll<HTMLElement>('[role="gridcell"]'),
    );
    const labels = cells.map((cell) => cell.getAttribute('aria-label') ?? '');

    expect(labels.some((label) => label.includes('8'))).toBe(true);
    expect(
      labels.filter((label) => label.toLowerCase().includes('empty')),
    ).toHaveLength(15);

    fixture.renderer.destroy();
  });

  it('rebuilds the layer at the size a commit changed the board to', () => {
    const fixture = harness();

    fixture.renderer.render(commitOf(3, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    expect(fixture.layer.boardSize()).toBe(3);
    expect(fixture.parallelHost.querySelectorAll('[role="gridcell"]')).toHaveLength(
      9,
    );
    expect(fixture.renderer.readStats().boardSize).toBe(3);

    fixture.renderer.destroy();
  });

  it('restores the host it found and leaves the layer populated', () => {
    const fixture = harness();

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);
    fixture.renderer.unmount();

    expect(fixture.layer.isMounted()).toBe(true);
    expect(fixture.parallelHost.getAttribute('aria-hidden')).toBeNull();

    fixture.renderer.destroy();
  });

  it('draws the board with no layer supplied at all', () => {
    const fixture = harness({ withLayer: false });

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));

    expect(() => {
      drain(fixture.renderer);
    }).not.toThrow();
    expect(fixture.renderer.readRenderedBoard()?.size).toBe(4);

    fixture.renderer.destroy();
  });
});

describe('board size bounds', () => {
  it('refuses a commit above the supported maximum and keeps the board drawn', () => {
    const fixture = harness();

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    const before = fixture.renderer.readStats();

    fixture.renderer.render(commitOf(64, [{ x: 0, y: 0, value: 2 }]));

    expect(fixture.countOf('render.three.size.refused')).toBe(1);
    expect(fixture.renderer.readStats().boardSize).toBe(before.boardSize);
    expect(fixture.renderer.readStats().refusedSizes).toBe(1);
    expect(fixture.renderer.readRenderedBoard()?.size).toBe(4);

    fixture.renderer.destroy();
  });

  it('falls back to the default size when the configured one is unsupported', () => {
    const fixture = harness({ boardSize: 0 });

    expect(fixture.renderer.mounted).toBe(true);
    expect(fixture.renderer.readStats().boardSize).toBe(4);

    fixture.renderer.destroy();
  });
});

describe('drawing one turn', () => {
  it('queues a commit and draws it on the next frame, never inside the event', () => {
    const fixture = harness();
    const paintsAtCommit = fixture.countOf('render.three.paint');

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));

    expect(fixture.countOf('render.three.render')).toBe(1);
    expect(fixture.countOf('render.three.paint')).toBe(paintsAtCommit);

    drain(fixture.renderer);

    expect(fixture.countOf('render.three.paint')).toBe(paintsAtCommit + 1);

    fixture.renderer.destroy();
  });

  it('holds a merge source on screen and releases it once it arrives', () => {
    const fixture = harness();

    fixture.renderer.render(
      commitOf(4, [
        {
          x: 1,
          y: 0,
          value: 4,
          merged: [
            { x: 1, y: 0, value: 2 },
            { x: 1, y: 0, value: 2 },
          ],
        },
      ]),
    );

    // One frame: the merged block plus the two blocks it consumed.
    fixture.renderer.frame({
      timestamp: 0,
      delta: 0,
      rawDelta: 0,
      deltaClamped: false,
      elapsed: 0,
      frame: 0,
    });

    expect(fixture.renderer.readStats().liveTiles).toBe(3);

    // Past the 100ms the sources are held for, which is the merged block's own
    // delay: they arrive and are released, leaving the merged block alone.
    drain(fixture.renderer);

    expect(fixture.renderer.readStats().liveTiles).toBe(1);

    fixture.renderer.destroy();
  });

  it('releases every block of the previous turn on the next paint', () => {
    const fixture = harness();

    fixture.renderer.render(
      commitOf(4, [
        { x: 0, y: 0, value: 2 },
        { x: 1, y: 0, value: 2 },
        { x: 2, y: 0, value: 4 },
      ]),
    );
    drain(fixture.renderer);

    expect(fixture.renderer.readStats().liveTiles).toBe(3);

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    expect(fixture.renderer.readStats().liveTiles).toBe(1);

    fixture.renderer.destroy();
  });

  it('settles to no outstanding work once every tween is complete', () => {
    const fixture = harness();

    fixture.renderer.render(
      commitOf(4, [{ x: 0, y: 1, value: 2, from: { x: 0, y: 3 } }]),
    );

    const frames = drain(fixture.renderer);

    expect(frames).toBeGreaterThan(0);
    expect(frames).toBeLessThan(64);
    expect(
      fixture.renderer.frame({
        timestamp: 4096,
        delta: 16,
        rawDelta: 16,
        deltaClamped: false,
        elapsed: 4096,
        frame: 999,
      }),
    ).toBe(false);

    fixture.renderer.destroy();
  });

  it('draws in one frame with no outstanding work while motion is reduced', () => {
    setReducedMotionOverride(true);

    const fixture = harness();

    fixture.renderer.render(
      commitOf(4, [
        { x: 0, y: 1, value: 2, from: { x: 0, y: 3 } },
        {
          x: 2,
          y: 2,
          value: 8,
          merged: [
            { x: 2, y: 2, value: 4 },
            { x: 2, y: 2, value: 4 },
          ],
        },
      ]),
    );

    expect(
      fixture.renderer.frame({
        timestamp: 0,
        delta: 0,
        rawDelta: 0,
        deltaClamped: false,
        elapsed: 0,
        frame: 0,
      }),
    ).toBe(false);

    // The merge sources never animate, so only the merged block remains.
    expect(fixture.renderer.readStats().liveTiles).toBe(2);

    fixture.renderer.destroy();
  });

  it('wakes a sleeping loop through onWork when a commit arrives', () => {
    const fixture = harness();
    const before = fixture.work();

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));

    expect(fixture.work()).toBeGreaterThan(before);

    fixture.renderer.destroy();
  });
});

describe('the tile:merge subscription', () => {
  it('queues one burst per merge, carrying the value onMerge resolved', () => {
    const fixture = harness();
    const events = createEngineEvents();
    const release = fixture.renderer.subscribe(events);
    const source = new Tile({ x: 1, y: 1 }, 2);
    const target = new Tile({ x: 1, y: 2 }, 2);

    events.emit('tile:merge', {
      turn: 1,
      source,
      target,
      resultValue: 64,
      scoreDelta: 64,
    });

    expect(fixture.renderer.readStats().pendingMerges).toBe(1);

    events.emit('state:commit', commitOf(4, [{ x: 1, y: 2, value: 64 }], 64));
    drain(fixture.renderer);

    expect(fixture.renderer.readStats().pendingMerges).toBe(0);

    release();
    fixture.renderer.destroy();
  });

  it('drops queued bursts when the commit that would have fired them is refused', () => {
    const fixture = harness();
    const events = createEngineEvents();
    const release = fixture.renderer.subscribe(events);

    events.emit('tile:merge', {
      turn: 1,
      source: new Tile({ x: 0, y: 0 }, 2),
      target: new Tile({ x: 0, y: 1 }, 2),
      resultValue: 4,
      scoreDelta: 4,
    });
    events.emit('state:commit', commitOf(64, [{ x: 0, y: 0, value: 2 }]));

    expect(fixture.renderer.readStats().pendingMerges).toBe(0);

    release();
    fixture.renderer.destroy();
  });
});

describe('readRenderedBoard', () => {
  it('describes every cell in row-major order with the ramp colours', () => {
    const fixture = harness();

    fixture.renderer.render(commitOf(4, [{ x: 3, y: 0, value: 16 }], 16));
    drain(fixture.renderer);

    const board = fixture.renderer.readRenderedBoard();

    expect(board).not.toBeNull();
    expect(board?.cells).toHaveLength(16);
    expect(board?.cells.at(3)?.value).toBe(16);
    expect(board?.cells.at(3)?.fill).toBe('#f59563');
    expect(board?.cells.at(3)?.numeralColor).toBe('#f9f6f2');
    expect(board?.cells.at(0)?.value).toBeNull();
    expect(board?.score).toBe(16);
    expect(board?.scoreDelta).toBe(16);
    expect(board?.themeId).toBe('default');

    fixture.renderer.destroy();
  });

  it('marks a merged, a spawned and a moved tile apart', () => {
    const fixture = harness();

    fixture.renderer.render(
      commitOf(4, [
        { x: 0, y: 0, value: 2 },
        { x: 1, y: 0, value: 2, from: { x: 3, y: 0 } },
        {
          x: 2,
          y: 0,
          value: 4,
          merged: [
            { x: 2, y: 0, value: 2 },
            { x: 2, y: 0, value: 2 },
          ],
        },
      ]),
    );
    drain(fixture.renderer);

    const cells = fixture.renderer.readRenderedBoard()?.cells ?? [];

    expect(cells.at(0)?.isNew).toBe(true);
    expect(cells.at(1)?.moved).toBe(true);
    expect(cells.at(1)?.isNew).toBe(false);
    expect(cells.at(2)?.isMerged).toBe(true);

    fixture.renderer.destroy();
  });

  it('carries the unestablished-status flag the commit reported', () => {
    const fixture = harness();

    fixture.renderer.render({
      ...commitOf(4, [{ x: 0, y: 0, value: 2 }]),
      degraded: true,
    });
    drain(fixture.renderer);

    expect(fixture.renderer.readRenderedBoard()?.degraded).toBe(true);

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    expect(fixture.renderer.readRenderedBoard()?.degraded).toBe(false);

    fixture.renderer.destroy();
  });

  it('names a cell exactly as the number-only renderer names it', () => {
    expect(threeRendererCopy.cellLabel).toBe(numberOnlyRendererCopy.cellLabel);
    expect(threeRendererCopy.emptyCellLabel).toBe(
      numberOnlyRendererCopy.emptyCellLabel,
    );
  });
});

describe('the subscription lifecycle', () => {
  it('never touches a renderer it was not subscribed to', () => {
    const fixture = harness();
    const events = createEngineEvents();

    events.emit('state:commit', commitOf(4, [{ x: 0, y: 0, value: 2 }]));

    expect(fixture.renderer.readStats().commits).toBe(0);

    fixture.renderer.destroy();
  });

  it('releases both listeners through the returned handle, idempotently', () => {
    const fixture = harness();
    const events = createEngineEvents();
    const release = fixture.renderer.subscribe(events);

    events.emit('state:commit', commitOf(4, [{ x: 0, y: 0, value: 2 }]));

    expect(fixture.renderer.readStats().commits).toBe(1);

    release();
    release();
    events.emit('state:commit', commitOf(4, [{ x: 1, y: 1, value: 2 }]));

    expect(fixture.renderer.readStats().commits).toBe(1);

    fixture.renderer.destroy();
  });

  it('drops every armed trigger on unmount, not only the merges', () => {
    const fixture = harness();
    const events = createEngineEvents();
    const release = fixture.renderer.subscribe(events);

    // All three granular triggers armed and none of them drawn: a merge, a
    // spawn, and the origins a resolved move recorded.
    events.emit('tile:merge', {
      turn: 1,
      source: new Tile({ x: 0, y: 0 }, 2),
      target: new Tile({ x: 0, y: 1 }, 2),
      resultValue: 4,
      scoreDelta: 4,
    });
    events.emit('tile:spawn', {
      turn: 1,
      position: { x: 3, y: 3 },
      value: 2,
    });
    events.emit('move:after', {
      turn: 1,
      moved: true,
      board: commitOf(4, [
        { x: 1, y: 1, value: 8, from: { x: 1, y: 3 } },
      ]).board,
      score: 8,
      over: false,
      won: false,
      terminated: false,
    });

    const armed = fixture.renderer.readStats();

    expect(armed.pendingMerges).toBe(1);
    expect(armed.pendingSpawns).toBe(1);
    expect(armed.pendingMoves).toBe(1);

    fixture.renderer.unmount();

    // All three. Unmount cleared only the merge queue, so a remount drew the
    // spawn tween and the slide of a board two commits old.
    const cleared = fixture.renderer.readStats();

    expect(cleared.pendingMerges).toBe(0);
    expect(cleared.pendingSpawns).toBe(0);
    expect(cleared.pendingMoves).toBe(0);

    release();
    fixture.renderer.destroy();
  });

  it('refuses a subscription taken after disposal', () => {
    const fixture = harness();
    const events = createEngineEvents();

    fixture.renderer.destroy();

    const release = fixture.renderer.subscribe(events);

    events.emit('state:commit', commitOf(4, [{ x: 0, y: 0, value: 2 }]));

    expect(fixture.renderer.readStats().commits).toBe(0);
    expect(fixture.countOf('render.three.subscribe.refused')).toBe(1);
    expect(() => {
      release();
    }).not.toThrow();
  });

  it('releases a subscription overtaken by disposal in flight', () => {
    const fixture = harness();
    const events = createEngineEvents();

    // A listener the same emitter already holds disposes the renderer while
    // the registration below is still in flight.
    events.on('state:commit', (): void => {
      fixture.renderer.destroy();
    });

    const disposeDuring = createEngineEvents();
    const originalOn = disposeDuring.on.bind(disposeDuring);
    const patched = {
      on: <K extends 'state:commit' | 'tile:merge'>(
        name: K,
        listener: Parameters<typeof originalOn<K>>[1],
      ): (() => void) => {
        const handle = originalOn(name, listener);

        fixture.renderer.destroy();

        return handle;
      },
      off: disposeDuring.off.bind(disposeDuring),
      emit: disposeDuring.emit.bind(disposeDuring),
    } as unknown as typeof disposeDuring;

    const release = fixture.renderer.subscribe(patched);

    disposeDuring.emit('state:commit', commitOf(4, [{ x: 0, y: 0, value: 2 }]));

    expect(fixture.renderer.readStats().commits).toBe(0);
    expect(fixture.countOf('render.three.subscribe.refused')).toBeGreaterThan(0);

    release();
  });

  it('is idempotent across unmount, dispose and destroy', () => {
    const fixture = harness();

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    expect(() => {
      fixture.renderer.unmount();
      fixture.renderer.unmount();
      fixture.renderer.dispose();
      fixture.renderer.destroy();
    }).not.toThrow();

    expect(fixture.renderer.readStats().disposed).toBe(true);
    expect(fixture.renderer.readStats().liveTiles).toBe(0);
    expect(fixture.renderer.frame()).toBe(false);
    expect(fixture.countOf('render.three.unmount')).toBe(1);
  });

  it('remounts after an unmount and draws again', () => {
    const fixture = harness();

    fixture.renderer.unmount();

    expect(fixture.renderer.mount()).toBe(true);
    expect(fixture.renderer.mounted).toBe(true);

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    expect(fixture.renderer.readRenderedBoard()?.size).toBe(4);
    expect(fixture.countOf('render.three.mount')).toBe(2);

    fixture.renderer.destroy();
  });
});

describe('context loss', () => {
  it('reports a lost context and keeps every other call safe', () => {
    const mock = createMockCanvas({ context: createMockWebGLContext().gl });
    const diagnostics: RenderDiagnostic[] = [];
    const renderer = createThreeRenderer({
      canvas: mock.element,
      ownerDocument: document,
      reporter: {
        onDiagnostic: (diagnostic): void => {
          diagnostics.push(diagnostic);
        },
        onCount: (): void => {},
        onTiming: (): void => {},
      },
    });

    expect(renderer.mounted).toBe(true);
    expect(renderer.readStats().contextLost).toBe(false);

    mock.emit('webglcontextlost');

    expect(renderer.readStats().contextLost).toBe(true);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('WebGL context was lost'),
      ),
    ).toBe(true);

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));

    expect(() => {
      drain(renderer);
    }).not.toThrow();

    mock.emit('webglcontextrestored');

    expect(renderer.readStats().contextLost).toBe(false);

    renderer.destroy();
  });
});

/** A controllable stand-in for the breakpoint's `MediaQueryList`. */
const stubScaleQuery = (): {
  readonly cross: () => void;
  readonly restore: () => void;
} => {
  const listeners: (() => void)[] = [];
  const original = window.matchMedia;
  let matches = false;

  const query = {
    get matches(): boolean {
      return matches;
    },
    media: '',
    onchange: null,
    addEventListener: (_type: string, listener: () => void): void => {
      listeners.push(listener);
    },
    removeEventListener: (_type: string, listener: () => void): void => {
      const index = listeners.indexOf(listener);

      if (index >= 0) {
        listeners.splice(index, 1);
      }
    },
    addListener: (listener: () => void): void => {
      listeners.push(listener);
    },
    removeListener: (): void => {},
    dispatchEvent: (): boolean => true,
  };

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (): MediaQueryList => query as unknown as MediaQueryList,
  });

  return {
    cross: (): void => {
      matches = !matches;

      for (const listener of Array.from(listeners)) {
        listener();
      }
    },
    restore: (): void => {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
};

describe('the change of scale', () => {
  it('redraws the board the commit already drew', () => {
    const scale = stubScaleQuery();

    try {
      const fixture = harness();

      fixture.renderer.render(
        commitOf(4, [
          { x: 0, y: 0, value: 2 },
          { x: 1, y: 1, value: 4 },
          { x: 2, y: 2, value: 8 },
        ]),
      );
      drain(fixture.renderer);

      expect(fixture.renderer.readStats().scale).toBe('desktop');
      expect(fixture.renderer.readStats().liveTiles).toBe(3);
      expect(fixture.renderer.readStats().boardsBuilt).toBe(1);

      // Crossing the breakpoint generates the board again, which recalls every
      // block into the factory's pool.
      scale.cross();

      expect(fixture.renderer.readStats().scale).toBe('mobile');
      expect(fixture.renderer.readStats().boardsBuilt).toBe(2);

      drain(fixture.renderer);

      expect(fixture.renderer.readStats().liveTiles).toBe(3);

      const board = fixture.renderer.readRenderedBoard();

      expect(
        board?.cells.filter((cell) => cell.value !== null),
      ).toHaveLength(3);

      // And back again, so the redraw is not one-directional.
      scale.cross();
      drain(fixture.renderer);

      expect(fixture.renderer.readStats().scale).toBe('desktop');
      expect(fixture.renderer.readStats().liveTiles).toBe(3);

      fixture.renderer.destroy();
    } finally {
      scale.restore();
    }
  });
});

/** A renderer over a mock canvas, with its reports collected. */
const guardFixture = (
  overrides: { readonly context?: unknown } = {},
): {
  readonly mock: ReturnType<typeof createMockCanvas>;
  readonly numberOnlyHost: HTMLElement;
  readonly renderer: ThreeRenderer;
  readonly diagnostics: RenderDiagnostic[];
  readonly counts: { name: string; value: number }[];
  readonly countOf: (name: string) => number;
} => {
  const numberOnlyHost = document.createElement('div');

  numberOnlyHost.id = 'board-number-only';
  numberOnlyHost.hidden = true;

  const mock = createMockCanvas({
    context:
      'context' in overrides ? overrides.context : createMockWebGLContext().gl,
  });

  document.body.append(numberOnlyHost, mock.element);

  const diagnostics: RenderDiagnostic[] = [];
  const counts: { name: string; value: number }[] = [];
  const renderer = createThreeRenderer({
    canvas: mock.element,
    numberOnlyHost,
    ownerDocument: document,
    reporter: {
      onDiagnostic: (diagnostic): void => {
        diagnostics.push(diagnostic);
      },
      onCount: (count): void => {
        counts.push({ name: count.name, value: count.value });
      },
      onTiming: (): void => {},
    },
  });

  return {
    mock,
    numberOnlyHost,
    renderer,
    diagnostics,
    counts,
    countOf: (name): number =>
      counts
        .filter((entry) => entry.name === name)
        .reduce((total, entry) => total + entry.value, 0),
  };
};

describe('the mount guard', () => {
  it('unwinds a failure and leaves the number-only host in its shipped state', () => {
    const fixture = guardFixture({ context: null });

    // The mount failed, and it failed WITHOUT stranding the caller: the
    // number-only host is still hidden exactly as index.html ships it, so the
    // composition root's fallback finds it untouched, and the canvas was not
    // left shown over an empty board.
    expect(fixture.renderer.mounted).toBe(false);
    expect(fixture.numberOnlyHost.hidden).toBe(true);
    expect(fixture.renderer.readStats().boardSize).toBe(0);
    expect(fixture.countOf('render.three.context.failed')).toBe(1);

    expect(() => {
      fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
      fixture.renderer.frame();
      fixture.renderer.destroy();
    }).not.toThrow();
  });

  it('reports the failure as a fallback instruction, not a bare error', () => {
    const fixture = guardFixture({ context: null });

    const reported = fixture.diagnostics.find(
      (diagnostic) => diagnostic.level === 'error',
    );

    expect(reported?.message).toContain('The 2.5D board did not mount');
    expect(reported?.message).toContain('number-only');

    fixture.renderer.destroy();
  });

  it('is idempotent: a second mount of the same canvas changes nothing', () => {
    const fixture = guardFixture();
    const before = fixture.renderer.readStats();

    expect(fixture.renderer.mount(fixture.mock.element)).toBe(true);

    const after = fixture.renderer.readStats();

    expect(after.boardSize).toBe(before.boardSize);
    expect(after.boardsBuilt).toBe(before.boardsBuilt);
    expect(fixture.countOf('render.three.mount')).toBe(1);

    fixture.renderer.destroy();
  });
});

describe('a lost context', () => {
  it('parks the loop rather than spinning frames for invisible work', () => {
    const fixture = guardFixture();

    fixture.renderer.render(
      commitOf(4, [
        { x: 0, y: 0, value: 4, merged: [{ x: 0, y: 0, value: 2 }, { x: 0, y: 1, value: 2 }] },
      ]),
    );

    // One frame draws the plan and arms the merge pop, so there IS outstanding
    // work in flight when the context goes.
    fixture.renderer.frame({
      timestamp: 0,
      delta: 16,
      rawDelta: 16,
      deltaClamped: false,
      elapsed: 0,
      frame: 0,
    });

    fixture.mock.emit('webglcontextlost');

    const stats = fixture.renderer.readStats();

    expect(stats.contextLost).toBe(true);
    expect(stats.contextLosses).toBe(1);

    expect(stats.activeTweens).toBe(0);
    expect(
      fixture.renderer.frame({
        timestamp: 16,
        delta: 16,
        rawDelta: 16,
        deltaClamped: false,
        elapsed: 16,
        frame: 1,
      }),
    ).toBe(false);

    fixture.renderer.destroy();
  });

  it('clears the pending effects the lost context owned', () => {
    const fixture = guardFixture();

    fixture.renderer.render(commitOf(4, [{ x: 1, y: 1, value: 8 }]));
    fixture.mock.emit('webglcontextlost');

    const stats = fixture.renderer.readStats();

    expect(stats.pendingMerges).toBe(0);
    expect(stats.pendingSpawns).toBe(0);
    expect(stats.pendingMoves).toBe(0);
    expect(stats.pendingTurn).toBeNull();

    fixture.renderer.destroy();
  });

  it('announces the fallback at error level, claiming only what is true', () => {
    const fixture = guardFixture();

    fixture.mock.emit('webglcontextlost');

    const announced = fixture.diagnostics.find(
      (diagnostic) =>
        diagnostic.level === 'error' &&
        diagnostic.message.includes('stopped drawing'),
    );

    expect(announced).toBeDefined();

    expect(announced?.message).toContain('keeps running');
    expect(announced?.message).toContain('accessible grid');
    expect(announced?.message).not.toContain('number-only board carries');

    fixture.renderer.destroy();
  });

  it('releases its GPU resources while the lost context still owns them', () => {
    const fixture = guardFixture();

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    expect(fixture.renderer.readStats().boardSize).toBe(4);

    fixture.mock.emit('webglcontextlost');

    const parked = fixture.renderer.readStats();

    expect(parked.boardSize).toBe(0);
    expect(parked.liveTiles).toBe(0);
    expect(parked.activeTweens).toBe(0);
    expect(parked.litStageIndex).toBeNull();

    // And every member is still safe to call while parked.
    expect(() => {
      fixture.renderer.render(commitOf(4, [{ x: 1, y: 1, value: 4 }]));
      fixture.renderer.frame();
    }).not.toThrow();

    fixture.renderer.destroy();
  });
});

describe('a restored context', () => {
  it('rebuilds the renderer-owned resources and reconciles the last board', () => {
    const fixture = guardFixture();

    fixture.renderer.render(
      commitOf(4, [
        { x: 0, y: 0, value: 2 },
        { x: 3, y: 3, value: 16 },
      ]),
    );
    drain(fixture.renderer);

    const drawn = fixture.renderer.readRenderedBoard();

    expect(drawn).not.toBeNull();

    fixture.mock.emit('webglcontextlost');
    fixture.mock.emit('webglcontextrestored');

    const stats = fixture.renderer.readStats();

    expect(stats.contextLost).toBe(false);
    expect(stats.contextRestores).toBe(1);
    expect(stats.boardSize).toBe(4);
    expect(stats.litStageIndex).toBeNull();

    drain(fixture.renderer);

    expect(fixture.renderer.readRenderedBoard()?.cells.length).toBe(16);
    expect(
      fixture.diagnostics.some((diagnostic) =>
        diagnostic.message.includes('rebuilt its'),
      ),
    ).toBe(true);

    fixture.renderer.destroy();
  });

  it('stays parked when the rebuild cannot be completed', () => {
    const context = createMockWebGLContext().gl;
    const numberOnlyHost = document.createElement('div');

    numberOnlyHost.hidden = true;

    const mock = createMockCanvas({ context });

    document.body.append(numberOnlyHost, mock.element);

    const diagnostics: RenderDiagnostic[] = [];
    const verdicts: ContextRestoreOutcome[] = [];
    const renderer = createThreeRenderer({
      canvas: mock.element,
      numberOnlyHost,
      ownerDocument: document,
      onContextRestored: (outcome): void => {
        verdicts.push(outcome);
      },
      reporter: {
        onDiagnostic: (diagnostic): void => {
          diagnostics.push(diagnostic);
        },
        onCount: (): void => {},
        onTiming: (): void => {},
      },
    });

    expect(renderer.mounted).toBe(true);

    // The canvas stops answering with a context, so the rebuild's own
    // `openSurface` fails.
    Object.defineProperty(mock.element, 'getContext', {
      configurable: true,
      value: (): null => null,
    });

    mock.emit('webglcontextlost');
    mock.emit('webglcontextrestored');

    expect(renderer.readStats().contextLost).toBe(true);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('could not be rebuilt'),
      ),
    ).toBe(true);

    // And the verdict is reported, so a caller does not read a restoration
    // that rebuilt nothing as a board that came back.
    expect(verdicts).toEqual([
      { rebuilt: false, contextLost: true, attempted: true },
    ]);

    const stats = renderer.readStats();

    expect(stats.boardSize).toBe(0);
    expect(stats.liveTiles).toBe(0);
    expect(stats.activeTweens).toBe(0);
    expect(renderer.readRenderedBoard()).toBeNull();

    // The caught value reaches the sink unconverted, beside the bounded
    // summary.
    const failure = diagnostics.find((diagnostic) =>
      diagnostic.message.includes('could not be rebuilt'),
    );

    expect(failure?.error?.name.length ?? 0).toBeGreaterThan(0);
    expect(failure?.thrown).toBeDefined();

    renderer.destroy();
  });

  it('reports a completed rebuild as the verdict of the restoration', () => {
    const fixture = harness();
    const verdicts: ContextRestoreOutcome[] = [];

    fixture.renderer.destroy();

    const mock = createMockCanvas({ context: createMockWebGLContext().gl });

    document.body.append(mock.element);

    const renderer = createThreeRenderer({
      canvas: mock.element,
      ownerDocument: document,
      onContextRestored: (outcome): void => {
        verdicts.push(outcome);
      },
    });

    expect(renderer.mounted).toBe(true);

    mock.emit('webglcontextlost');
    mock.emit('webglcontextrestored');

    expect(verdicts).toEqual([
      { rebuilt: true, contextLost: false, attempted: true },
    ]);
    expect(renderer.readStats().contextLost).toBe(false);

    renderer.destroy();
  });

  it('forwards no verdict for a restoration after destroy', () => {
    const verdicts: ContextRestoreOutcome[] = [];
    const mock = createMockCanvas({ context: createMockWebGLContext().gl });

    document.body.append(mock.element);

    const renderer = createThreeRenderer({
      canvas: mock.element,
      ownerDocument: document,
      onContextRestored: (outcome): void => {
        verdicts.push(outcome);
      },
    });

    mock.emit('webglcontextlost');
    renderer.destroy();
    mock.emit('webglcontextrestored');

    expect(verdicts).toEqual([]);
  });
});

describe('a commit that lands while the context is lost', () => {
  /**
   * The cells of the parallel board, in the row-major order the layer builds.
   */
  const parallelLabels = (host: HTMLElement): string[] =>
    Array.from(host.querySelectorAll<HTMLElement>('[role="gridcell"]')).map(
      (cell) => cell.getAttribute('aria-label') ?? '',
    );

  it('keeps the parallel accessibility grid on the board the engine committed', () => {
    const fixture = harness();

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    fixture.emit('webglcontextlost');

    // A turn resolves while the context is dead.
    fixture.renderer.render(commitOf(4, [{ x: 3, y: 3, value: 64 }]));
    drain(fixture.renderer);

    const labels = parallelLabels(fixture.parallelHost);

    // Row-major: the tile the outage's turn placed is the last cell, and the
    // cell the pre-loss board held is empty again.
    expect(labels.at(15) ?? '').toContain('64');
    expect((labels.at(0) ?? '').toLowerCase()).toContain('empty');
    expect(
      labels.filter((label) => label.toLowerCase().includes('empty')),
    ).toHaveLength(15);

    // Still parked, and still not drawing: the grid stayed current WITHOUT the
    // renderer issuing a frame against the lost context.
    expect(fixture.renderer.readStats().contextLost).toBe(true);

    fixture.renderer.destroy();
  });

  it('reconciles the restoration to the turn resolved during the outage', () => {
    const fixture = harness();

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    fixture.emit('webglcontextlost');
    fixture.renderer.render(commitOf(4, [{ x: 3, y: 3, value: 64 }]));
    drain(fixture.renderer);

    fixture.emit('webglcontextrestored');
    drain(fixture.renderer);

    const board = fixture.renderer.readRenderedBoard();
    const cells = board?.cells ?? [];

    // The latest committed state, not the one the loss interrupted: the plan
    // is plain data and `paint` keeps it current through the outage, so the
    // board comes back showing the turn that resolved while it was dark.
    expect(cells.find((cell) => cell.x === 3 && cell.y === 3)?.value).toBe(64);
    expect(cells.find((cell) => cell.x === 0 && cell.y === 0)?.value).toBeNull();
    expect(fixture.renderer.readStats().contextRestores).toBe(1);
    expect(
      fixture.diagnostics.some(
        (diagnostic) =>
          diagnostic.message.includes('rebuilt its') &&
          (diagnostic.detail as { reconciled?: boolean } | undefined)
            ?.reconciled === true,
      ),
    ).toBe(true);

    fixture.renderer.destroy();
  });

  it('reports the board the loss interrupted rather than the absence it left', () => {
    const fixture = harness();

    fixture.renderer.render(commitOf(4, [{ x: 1, y: 1, value: 8 }]));
    drain(fixture.renderer);

    fixture.emit('webglcontextlost');

    // The renderer's own diagnostic, not the support module's: both report the
    // loss, and only this one carries the board it interrupted.
    const loss = fixture.diagnostics.find((diagnostic) =>
      diagnostic.message.includes('has stopped drawing'),
    );

    // Read before the release, which zeroes it.
    expect(
      (loss?.detail as { boardSize?: number } | undefined)?.boardSize,
    ).toBe(4);
    expect((loss?.detail as { losses?: number } | undefined)?.losses).toBe(1);

    fixture.renderer.destroy();
  });

  it('drops the triggers armed for a plan no board can draw', () => {
    const fixture = harness();
    const events = createEngineEvents();

    fixture.renderer.subscribe(events);
    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    fixture.emit('webglcontextlost');

    events.emit('tile:merge', {
      turn: 2,
      source: new Tile({ x: 0, y: 1 }, 2),
      target: new Tile({ x: 0, y: 0 }, 2),
      resultValue: 4,
      scoreDelta: 4,
    });

    expect(fixture.renderer.readStats().pendingMerges).toBe(1);

    fixture.renderer.render({
      ...commitOf(4, [{ x: 0, y: 0, value: 4 }]),
      turn: 2,
    });
    drain(fixture.renderer);

    expect(fixture.renderer.readStats().pendingMerges).toBe(0);
    expect(fixture.renderer.readStats().pendingTurn).toBeNull();

    fixture.renderer.destroy();
  });
});

describe('animation triggers are scoped to their turn', () => {
  /** A commit carrying an explicit turn. */
  const commitAt = (turn: number, placed: readonly Placed[]): StateCommitEvent =>
    ({ ...commitOf(4, placed), turn });

  it('drains a trigger only into the commit of its own turn', () => {
    const fixture = guardFixture();
    const events = createEngineEvents();

    fixture.renderer.subscribe(events);

    // A merge armed by turn 7.
    events.emit('tile:merge', {
      turn: 7,
      source: new Tile({ x: 0, y: 1 }, 2),
      target: new Tile({ x: 0, y: 0 }, 2),
      resultValue: 4,
      scoreDelta: 4,
    });

    expect(fixture.renderer.readStats().pendingMerges).toBe(1);
    expect(fixture.renderer.readStats().pendingTurn).toBe(7);

    events.emit('state:commit', commitAt(8, [{ x: 0, y: 0, value: 4 }]));

    const stats = fixture.renderer.readStats();

    expect(stats.pendingMerges).toBe(0);
    expect(stats.pendingTurn).toBeNull();
    expect(stats.orphanedTriggers).toBe(1);
    expect(fixture.countOf('render.three.orphaned_triggers')).toBe(1);

    fixture.renderer.destroy();
  });

  it('keeps a trigger for the commit that matches it', () => {
    const fixture = guardFixture();
    const events = createEngineEvents();

    fixture.renderer.subscribe(events);

    events.emit('tile:merge', {
      turn: 3,
      source: new Tile({ x: 0, y: 1 }, 2),
      target: new Tile({ x: 0, y: 0 }, 2),
      resultValue: 4,
      scoreDelta: 4,
    });
    events.emit('tile:spawn', { turn: 3, position: { x: 2, y: 2 }, value: 2 });

    expect(fixture.renderer.readStats().pendingMerges).toBe(1);
    expect(fixture.renderer.readStats().pendingSpawns).toBe(1);

    events.emit(
      'state:commit',
      commitAt(3, [
        { x: 0, y: 0, value: 4 },
        { x: 2, y: 2, value: 2 },
      ]),
    );

    // Nothing was discarded, and the plan consumed the triggers as it drew.
    expect(fixture.renderer.readStats().orphanedTriggers).toBe(0);

    drain(fixture.renderer);

    expect(fixture.renderer.readStats().pendingMerges).toBe(0);

    fixture.renderer.destroy();
  });

  it('discards an older turn\'s triggers when a newer turn starts arming', () => {
    const fixture = guardFixture();
    const events = createEngineEvents();

    fixture.renderer.subscribe(events);

    events.emit('tile:spawn', { turn: 1, position: { x: 0, y: 0 }, value: 2 });
    events.emit('tile:spawn', { turn: 2, position: { x: 1, y: 1 }, value: 4 });

    const stats = fixture.renderer.readStats();

    expect(stats.pendingTurn).toBe(2);
    expect(stats.pendingSpawns).toBe(1);
    expect(stats.orphanedTriggers).toBe(1);

    fixture.renderer.destroy();
  });

  it('refuses a late arrival from a superseded turn', () => {
    const fixture = guardFixture();
    const events = createEngineEvents();

    fixture.renderer.subscribe(events);

    events.emit('tile:spawn', { turn: 5, position: { x: 0, y: 0 }, value: 2 });
    events.emit('tile:spawn', { turn: 4, position: { x: 3, y: 3 }, value: 4 });

    const stats = fixture.renderer.readStats();

    expect(stats.pendingTurn).toBe(5);
    expect(stats.pendingSpawns).toBe(1);
    expect(stats.orphanedTriggers).toBe(1);

    fixture.renderer.destroy();
  });
});

describe('unmount and remount', () => {
  it('clears every buffer, not just the merge list', () => {
    const fixture = guardFixture();
    const events = createEngineEvents();

    fixture.renderer.subscribe(events);

    events.emit('tile:merge', {
      turn: 1,
      source: new Tile({ x: 0, y: 1 }, 2),
      target: new Tile({ x: 0, y: 0 }, 2),
      resultValue: 4,
      scoreDelta: 4,
    });
    events.emit('tile:spawn', { turn: 1, position: { x: 2, y: 2 }, value: 2 });
    events.emit('move:after', {
      turn: 1,
      moved: true,
      board: commitOf(4, [{ x: 1, y: 1, value: 2, from: { x: 0, y: 1 } }]).board,
      score: 4,
      over: false,
      won: false,
      terminated: false,
    });

    const armed = fixture.renderer.readStats();

    expect(armed.pendingMerges).toBe(1);
    expect(armed.pendingSpawns).toBe(1);
    expect(armed.pendingMoves).toBe(1);

    fixture.renderer.unmount();

    const cleared = fixture.renderer.readStats();

    expect(cleared.pendingMerges).toBe(0);
    expect(cleared.pendingSpawns).toBe(0);
    expect(cleared.pendingMoves).toBe(0);
    expect(cleared.pendingTurn).toBeNull();
    expect(cleared.mounted).toBe(false);

    fixture.renderer.destroy();
  });

  it('remounts from the next commit rather than from a stale plan', () => {
    const fixture = guardFixture();

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }], 4));
    drain(fixture.renderer);

    fixture.renderer.unmount();

    expect(fixture.renderer.readRenderedBoard()).not.toBeNull();
    expect(fixture.renderer.mount(fixture.mock.element)).toBe(true);

    // Nothing is queued from before the unmount, so the first frame after a
    // remount paints only once a commit has arrived.
    const stats = fixture.renderer.readStats();

    expect(stats.mounted).toBe(true);
    expect(stats.contextLosses).toBe(0);
    expect(stats.orphanedTriggers).toBe(0);

    fixture.renderer.render(commitOf(4, [{ x: 3, y: 3, value: 32 }], 40));
    drain(fixture.renderer);

    const drawn = fixture.renderer.readRenderedBoard();

    expect(
      drawn?.cells.filter((cell) => cell.value !== null).map((cell) => cell.value),
    ).toEqual([32]);

    fixture.renderer.destroy();
  });

  it('does not accumulate subscriptions across mount cycles', () => {
    const fixture = guardFixture();
    const events = createEngineEvents();

    // Three cycles, each releasing its own subscription.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const release = fixture.renderer.subscribe(events);

      release();

      // Idempotent, as the contract promises.
      release();
    }

    events.emit('state:commit', commitOf(4, [{ x: 0, y: 0, value: 2 }], 4));

    expect(fixture.renderer.readStats().commits).toBe(0);
    expect(() => {
      fixture.renderer.destroy();
    }).not.toThrow();
  });
});

describe('the pixel-store unpack state is left as it was found', () => {
  /** A mock context whose `pixelStorei` writes are recorded in order. */
  const recordingContext = (): {
    readonly gl: Record<string, unknown>;
    readonly writes: { readonly parameter: string | undefined;
      readonly value: unknown }[];
  } => {
    const mock = createMockWebGLContext();
    const writes: { parameter: string | undefined; value: unknown }[] = [];

    // The fixture's context is a Proxy with no `set` trap, so a direct
    // assignment lands on its target and its `get` returns this in preference
    // to the generated stub.
    (mock.gl as Record<string, unknown>)['pixelStorei'] = (
      parameter: number,
      value: unknown,
    ): void => {
      writes.push({ parameter: mock.nameOf(parameter), value });
    };

    return { gl: mock.gl, writes };
  };

  /** The two flags the specification forbids for a 3D texture upload. */
  const FORBIDDEN_FOR_3D = [
    'UNPACK_FLIP_Y_WEBGL',
    'UNPACK_PREMULTIPLY_ALPHA_WEBGL',
  ] as const;

  it('resets both forbidden flags when the renderer is destroyed', () => {
    const context = recordingContext();
    const fixture = harness({ context: context.gl });

    expect(fixture.renderer.mount()).toBe(true);

    const beforeTeardown = context.writes.length;

    fixture.renderer.destroy();

    // Every numeral is a `CanvasTexture`, whose `flipY` is true, so this
    // renderer left `UNPACK_FLIP_Y_WEBGL` set on a context that outlives it —
    // and the next renderer built on the same canvas begins with the two
    // placeholder 3D uploads for which both flips are forbidden. DL-THREE-05.
    const reset = context.writes.slice(beforeTeardown);

    for (const flag of FORBIDDEN_FOR_3D) {
      expect(reset).toContainEqual({ parameter: flag, value: false });
    }
  });

  it('resets them on the context-loss release path as well', () => {
    const context = recordingContext();
    const fixture = harness({ context: context.gl });

    expect(fixture.renderer.mount()).toBe(true);

    const beforeLoss = context.writes.length;

    // `parkForContextLoss` releases every GPU resource through the same helper
    // a rebuild uses, so both teardowns hand the canvas back the same way.
    fixture.emit('webglcontextlost');

    const reset = context.writes.slice(beforeLoss);

    for (const flag of FORBIDDEN_FOR_3D) {
      expect(reset).toContainEqual({ parameter: flag, value: false });
    }

    fixture.renderer.destroy();
  });

  it('resets them once per release, not once per numeral', () => {
    const context = recordingContext();
    const fixture = harness({ context: context.gl });

    expect(fixture.renderer.mount()).toBe(true);

    const beforeTeardown = context.writes.length;

    fixture.renderer.destroy();

    const reset = context.writes.slice(beforeTeardown);
    const flips = reset.filter(
      (write) => write.parameter === 'UNPACK_FLIP_Y_WEBGL',
    );

    // One write per flag: the reset belongs to the release, not to the twelve
    // numeral textures whose uploads set the flag in the first place.
    expect(flips).toHaveLength(1);
  });

  it('writes false, never true, so the initial state is what is restored', () => {
    const context = recordingContext();
    const fixture = harness({ context: context.gl });

    expect(fixture.renderer.mount()).toBe(true);

    const beforeTeardown = context.writes.length;

    fixture.renderer.destroy();

    const reset = context.writes.slice(beforeTeardown);

    // The specification's initial value for both is false, and restoring means
    // exactly that — anything else would trade one surviving flag for another.
    expect(reset.every((write) => write.value === false)).toBe(true);
    expect(reset).not.toHaveLength(0);
  });

  it('does not raise where the renderer exposes no context accessor', () => {
    // The guard exists for a double that implements no accessor, and for a
    // context the browser has already taken away.
    const mock = createMockWebGLContext();

    (mock.gl as Record<string, unknown>)['pixelStorei'] = undefined;

    const fixture = harness({ context: mock.gl });

    expect(fixture.renderer.mount()).toBe(true);
    expect(() => {
      fixture.renderer.destroy();
    }).not.toThrow();
  });
});
