// Contract suite for the 2.5D renderer, AAP R1, R7 and R9.
//
// Five properties are pinned here, because each is a runtime defect rather than
// a compile error and none of the five is visible to the type checker:
//
//   inversion    js/html_actuator.js was PUSHED to — the controller held it and
//                called `actuate()`. This renderer must never be reachable that
//                way: it subscribes, and a commit it was not subscribed to must
//                leave it untouched.
//   semantics    `#board-canvas` carries `aria-hidden="true"` and is one opaque
//                node to a screen reader, so this renderer MUST mount the
//                parallel `role="grid"` layer beside it — the mirror image of
//                what src/render/number-only-renderer.ts does with the same two
//                arguments. A canvas board with no parallel layer is a board no
//                assistive technology can read.
//   bounds       a board-mutating relic can commit a size beyond what the
//                product supports, and the geometry, the mesh pool and the
//                lattice are all functions of that size. A refused commit must
//                leave the board already drawn standing.
//   cadence      the two blocks a merge consumed are released when they arrive,
//                which is the frame the merged block starts to grow. Releasing
//                them earlier makes the merge look like a teleport; never
//                releasing them leaks a mesh per merge.
//   lifecycle    `subscribe()` registers on an emitter that outlives this
//                renderer, and `mount()` acquires a GPU context that Three.js
//                frees for nobody.
//
// WHY A MOCKED CONTEXT
//   jsdom implements no rendering context, so `WebGLRenderer` cannot be built
//   under this environment at all. tests/fixtures/webgl.ts supplies a context
//   mocked far enough that Three.js constructs, resizes and renders without
//   throwing, which is exactly the reach these five properties need: not one of
//   them depends on what the driver rasterises. The pixels are the recorded
//   gameplay suite's business.

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

/* ==========================================================================
 * Fixtures
 * ========================================================================== */

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

/* ==========================================================================
 * Mounting and the WebGL prerequisite
 * ========================================================================== */

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
          diagnostic.message.includes('WebGL context could not be acquired'),
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

/* ==========================================================================
 * The parallel accessibility board
 * ========================================================================== */

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

    // Mounted still: the surface the next renderer takes over is populated
    // rather than an empty `role="grid"`.
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

/* ==========================================================================
 * Board size bounds
 * ========================================================================== */

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

/* ==========================================================================
 * The turn, and the merge cadence
 * ========================================================================== */

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

/* ==========================================================================
 * The granular merge event
 * ========================================================================== */

describe('the tile:merge subscription', () => {
  it('queues one burst per merge, carrying the value onMerge resolved', () => {
    const fixture = harness();
    const events = createEngineEvents();
    const release = fixture.renderer.subscribe(events);
    const source = new Tile({ x: 1, y: 1 }, 2);
    const target = new Tile({ x: 1, y: 2 }, 2);

    events.emit('tile:merge', {
      source,
      target,
      // A relic could have transformed this; the burst must use the resolved
      // value rather than doubling the source itself.
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

/* ==========================================================================
 * The projection a consumer reads
 * ========================================================================== */

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

  it('names a cell exactly as the number-only renderer names it', () => {
    expect(threeRendererCopy.cellLabel).toBe(numberOnlyRendererCopy.cellLabel);
    expect(threeRendererCopy.emptyCellLabel).toBe(
      numberOnlyRendererCopy.emptyCellLabel,
    );
  });
});

/* ==========================================================================
 * Lifecycle
 * ========================================================================== */

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

    // A listener the same emitter already holds disposes the renderer while the
    // registration below is still in flight.
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

/* ==========================================================================
 * Context loss
 * ========================================================================== */

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
