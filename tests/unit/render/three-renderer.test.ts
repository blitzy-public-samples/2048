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
import {
  createThreeRenderer,
  releaseParkedRenderer,
} from '../../../src/render/three-renderer';
import type {
  ContextRestoreOutcome,
  ParallelBoardSurface,
  ThreeRenderer,
} from '../../../src/render/three-renderer';
import { threeRendererCopy } from '../../../src/render/three-renderer';
import type {
  RenderDetail,
  RenderDiagnostic,
  RenderReporter,
} from '../../../src/render/webgl-support';
import { setReducedMotionOverride } from '../../../src/render/webgl-support';
import { resolveBoardGeometry } from '../../../src/render/tile-mesh-factory';
import { createParallelBoardLayer } from '../../../src/ui/a11y/focus-manager';
import { applyTheme } from '../../../src/theme/themes';
import { createMockCanvas, createMockWebGLContext } from '../../fixtures/webgl';
import type { MockWebGLContext } from '../../fixtures/webgl';

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
  readonly counts: {
    readonly name: string;
    readonly value: number;
    readonly detail?: Readonly<Record<string, unknown>>;
  }[];
  readonly work: () => number;
  readonly countOf: (name: string) => number;

  /**
   * The DETAIL of the last count under one name, or `undefined`.
   *
   * The board count carries the geometry the board was actually laid out with,
   * which is how a case reads the real cell pitch and tile footprint rather
   * than the scale's name.
   */
  readonly detailOf: (name: string) => Readonly<Record<string, unknown>> | undefined;

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
  const counts: {
    name: string;
    value: number;
    detail?: Readonly<Record<string, unknown>>;
  }[] = [];
  const reporter: RenderReporter = {
    onDiagnostic: (diagnostic): void => {
      diagnostics.push(diagnostic);
    },
    onCount: (count): void => {
      counts.push({
        name: count.name,
        value: count.value,
        ...(count.detail === undefined
          ? {}
          : { detail: count.detail as Readonly<Record<string, unknown>> }),
      });
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
    detailOf: (
      name: string,
    ): Readonly<Record<string, unknown>> | undefined =>
      counts.filter((entry) => entry.name === name).at(-1)?.detail,
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

/* ==========================================================================
 * A SUBSCRIPTION THAT CANNOT BE COMPLETED
 *
 * `subscribe()` takes the six names of AAP Contract 1. They were taken in one
 * array literal, so a throw from the third `on()` left the first two attached to
 * the emitter with no reference to them anywhere: this renderer went on drawing
 * for an engine it had reported it was not subscribed to, and neither
 * `dispose()` nor the returned release could reach them. DL-THREE-09.
 * ========================================================================== */

/** The six names `ThreeRenderer.subscribe()` registers, in order. */
const SUBSCRIBED_EVENT_NAMES: readonly string[] = Object.freeze([
  'stage:start',
  'tile:merge',
  'tile:spawn',
  'move:after',
  'stage:end',
  'state:commit',
]);

/**
 * An event source that refuses the `ordinal`-th registration.
 *
 * Wraps a real emitter, so every registration it does admit is a genuine one
 * and a case can count what is left attached afterwards.
 *
 * @param ordinal Zero-based index of the registration that raises.
 * @returns The source, and readers over what it holds.
 */
const refusingSource = (
  ordinal: number,
): {
  readonly events: ReturnType<typeof createEngineEvents>;
  readonly attached: () => readonly string[];
  readonly admit: () => void;
} => {
  const inner = createEngineEvents();
  const held: string[] = [];
  let refuse = true;
  let seen = 0;

  const events = {
    ...inner,
    on: ((name: string, listener: never): (() => void) => {
      const index = seen;

      seen += 1;

      if (refuse && index === ordinal) {
        throw new Error(`the source refused ${name}`);
      }

      const release = (
        inner.on as unknown as (
          eventName: string,
          handler: never,
        ) => () => void
      )(name, listener);

      held.push(name);

      return (): void => {
        const at = held.indexOf(name);

        if (at >= 0) {
          held.splice(at, 1);
        }

        release();
      };
    }) as ReturnType<typeof createEngineEvents>['on'],
  } as ReturnType<typeof createEngineEvents>;

  return {
    events,
    attached: (): readonly string[] => [...held],
    admit: (): void => {
      refuse = false;
      seen = 0;
    },
  };
};

describe('a subscription that cannot be completed', () => {
  for (let ordinal = 0; ordinal < SUBSCRIBED_EVENT_NAMES.length; ordinal += 1) {
    const failing = SUBSCRIBED_EVENT_NAMES[ordinal] ?? '';

    it(`rolls back the ${String(ordinal)} listeners taken before ${failing}`,
      () => {
        const fixture = harness();
        const source = refusingSource(ordinal);

        expect(() => fixture.renderer.subscribe(source.events)).toThrow(
          /refused/,
        );

        // NOTHING IS LEFT ATTACHED: the listeners taken before the refusal were
        // released, so the emitter is exactly as it was.
        expect(source.attached()).toEqual([]);

        // The refusal is reported rather than being silent.
        expect(
          fixture.countOf('render.three.subscribe.refused'),
        ).toBeGreaterThan(0);

        // AND NOTHING WAS DRAWN FOR THE HALF-SUBSCRIPTION: a commit through the
        // source reaches no listener, so the renderer's counters do not move.
        const before = fixture.renderer.readStats().commits;

        source.events.emit(
          'state:commit',
          commitOf(4, [{ x: 0, y: 0, value: 2 }]),
        );

        expect(fixture.renderer.readStats().commits).toBe(before);

        fixture.renderer.destroy();
      });
  }

  it('subscribes cleanly on a retry once the source admits', () => {
    // RETRYABLE, which is the point of rolling back rather than half-attaching:
    // the same renderer and the same source complete the subscription.
    const fixture = harness();
    const source = refusingSource(3);

    expect(() => fixture.renderer.subscribe(source.events)).toThrow(/refused/);
    expect(source.attached()).toEqual([]);

    source.admit();

    const release = fixture.renderer.subscribe(source.events);

    expect(source.attached()).toEqual(SUBSCRIBED_EVENT_NAMES);

    source.events.emit('state:commit', commitOf(4, [{ x: 0, y: 0, value: 2 }]));

    expect(fixture.renderer.readStats().commits).toBe(1);

    // And the release still takes every one of them back off.
    release();

    expect(source.attached()).toEqual([]);

    fixture.renderer.destroy();
  });

  it('keeps the shared collection accurate when a release refuses', () => {
    // The release half of the same lifecycle: one listener whose release raises
    // must not strand the other five in the renderer's own collection, or
    // `dispose()` calls each of them a second time.
    const fixture = harness();
    const inner = createEngineEvents();
    let refusals = 0;
    const events = {
      ...inner,
      on: ((name: string, listener: never): (() => void) => {
        const release = (
          inner.on as unknown as (
            eventName: string,
            handler: never,
          ) => () => void
        )(name, listener);

        if (name !== 'tile:spawn') {
          return release;
        }

        return (): void => {
          refusals += 1;
          release();

          throw new Error('this release refuses');
        };
      }) as ReturnType<typeof createEngineEvents>['on'],
    } as ReturnType<typeof createEngineEvents>;

    const release = fixture.renderer.subscribe(events);

    expect(() => {
      release();
    }).toThrow(/refuses/);

    expect(refusals).toBe(1);

    // Every listener was released despite the refusal, so a commit reaches
    // none of them.
    events.emit('state:commit', commitOf(4, [{ x: 0, y: 0, value: 2 }]));

    expect(fixture.renderer.readStats().commits).toBe(0);

    // And `destroy()` does not call the released listeners a second time.
    fixture.renderer.destroy();

    expect(refusals).toBe(1);
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

/* ==========================================================================
 * One `WebGLRenderer` per canvas, parked across an unmount and across a whole
 * renderer object, because an appearance switch destroys this renderer and
 * builds another over the SAME canvas. Ten of those switches grew the live
 * `WebGLTexture` count from 12 to 71 and the `WebGLProgram` count from 6 to 15,
 * since each construction takes its own placeholder textures and programs from
 * the canvas's context and `dispose()` leaves them behind. DL-THREE-06.
 * ========================================================================== */

describe('the renderer parked over a canvas', () => {
  /** A renderer over one caller-supplied canvas, with its counts collected. */
  const over = (
    element: HTMLCanvasElement,
  ): {
    readonly renderer: ThreeRenderer;
    readonly countOf: (name: string) => number;
  } => {
    const counts: { name: string; value: number }[] = [];
    const renderer = createThreeRenderer({
      canvas: element,
      ownerDocument: document,
      reporter: {
        onDiagnostic: (): void => {},
        onCount: (count): void => {
          counts.push({ name: count.name, value: count.value });
        },
        onTiming: (): void => {},
      },
    });

    return {
      renderer,
      countOf: (name): number =>
        counts
          .filter((entry) => entry.name === name)
          .reduce((total, entry) => total + entry.value, 0),
    };
  };

  it('is reused by a remount rather than rebuilt', () => {
    const mock = createMockCanvas({ context: createMockWebGLContext().gl });

    document.body.append(mock.element);

    const first = over(mock.element);

    expect(first.renderer.mounted).toBe(true);
    expect(first.countOf('render.three.surface.opened')).toBe(1);

    // Every `getContext` this canvas has been asked for. A construction asks;
    // reusing a parked instance does not.
    const acquired = mock.requests.length;

    expect(acquired).toBeGreaterThan(0);

    // Refused while the board is drawing: this is not a parked renderer.
    expect(releaseParkedRenderer(mock.element)).toBe(false);

    first.renderer.unmount();

    expect(first.renderer.mount()).toBe(true);
    expect(mock.requests.length).toBe(acquired);
    expect(first.countOf('render.three.surface.reused')).toBe(1);
    expect(first.countOf('render.three.surface.opened')).toBe(1);

    // And it still draws with the instance it took back.
    first.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(first.renderer);

    expect(first.renderer.readRenderedBoard()?.size).toBe(4);

    // The case the counts were measured in: a WHOLE NEW renderer object over
    // the same canvas, which is what an appearance switch builds.
    first.renderer.destroy();

    const second = over(mock.element);

    expect(second.renderer.mounted).toBe(true);
    expect(mock.requests.length).toBe(acquired);
    expect(second.countOf('render.three.surface.reused')).toBe(1);
    expect(second.countOf('render.three.surface.opened')).toBe(0);

    second.renderer.destroy();

    expect(releaseParkedRenderer(mock.element)).toBe(true);

    mock.element.remove();
  });

  it('is rebuilt once a caller releases it', () => {
    const mock = createMockCanvas({ context: createMockWebGLContext().gl });

    document.body.append(mock.element);

    const first = over(mock.element);
    const acquired = mock.requests.length;

    first.renderer.destroy();

    // The composition root's disposal, and the only place the context is given
    // back.
    expect(releaseParkedRenderer(mock.element)).toBe(true);

    // Released, so nothing is parked and a second release finds nothing.
    expect(releaseParkedRenderer(mock.element)).toBe(false);

    const second = over(mock.element);

    expect(second.renderer.mounted).toBe(true);
    expect(mock.requests.length).toBeGreaterThan(acquired);
    expect(second.countOf('render.three.surface.opened')).toBe(1);
    expect(second.countOf('render.three.surface.reused')).toBe(0);

    second.renderer.destroy();
    releaseParkedRenderer(mock.element);
    mock.element.remove();
  });

  it('reports the release the application disposal makes', () => {
    const mock = createMockCanvas({ context: createMockWebGLContext().gl });

    document.body.append(mock.element);

    const fixture = over(mock.element);

    expect(fixture.countOf('render.three.surface.opened')).toBe(1);
    expect(fixture.countOf('render.three.surface.released')).toBe(0);

    // The composition root's teardown: the renderer is destroyed, which PARKS
    // the context, and then the canvas is declared finished with.
    fixture.renderer.destroy();

    expect(fixture.countOf('render.three.surface.released')).toBe(0);
    expect(releaseParkedRenderer(mock.element)).toBe(true);

    // COUNTED. The normal final release is the one an ordinary teardown makes,
    // and it went unreported while the context-loss release was reported — so
    // the counter never balanced `opened` on a disposal. DL-THREE-11.
    expect(fixture.countOf('render.three.surface.released')).toBe(1);
    expect(fixture.countOf('render.three.surface.opened')).toBe(1);

    // A release that finds nothing parked reports nothing.
    expect(releaseParkedRenderer(mock.element)).toBe(false);
    expect(fixture.countOf('render.three.surface.released')).toBe(1);

    mock.element.remove();
  });

  it('reports a release through the sink of the last renderer to mount', () => {
    const mock = createMockCanvas({ context: createMockWebGLContext().gl });

    document.body.append(mock.element);

    // An appearance switch: the first renderer is destroyed and a second is
    // built over the SAME canvas, taking the parked context back.
    const first = over(mock.element);

    first.renderer.destroy();

    const second = over(mock.element);

    expect(second.countOf('render.three.surface.reused')).toBe(1);

    second.renderer.destroy();

    expect(releaseParkedRenderer(mock.element)).toBe(true);

    // The live sink is the one reported through; the destroyed renderer's own
    // sink is not reached, so a disposed owner cannot be handed a count.
    expect(second.countOf('render.three.surface.released')).toBe(1);
    expect(first.countOf('render.three.surface.released')).toBe(0);

    mock.element.remove();
  });

  it('is released rather than parked when the context is lost', () => {
    const mock = createMockCanvas({ context: createMockWebGLContext().gl });

    document.body.append(mock.element);

    const fixture = over(mock.element);
    const acquired = mock.requests.length;

    mock.emit('webglcontextlost');

    expect(fixture.renderer.readStats().contextLost).toBe(true);

    // A lost context takes its objects with it, so the instance holding it is
    // released and un-parked: there is nothing left to reuse.
    expect(fixture.countOf('render.three.surface.released')).toBe(1);
    expect(releaseParkedRenderer(mock.element)).toBe(false);

    mock.emit('webglcontextrestored');

    expect(fixture.renderer.readStats().contextLost).toBe(false);
    expect(mock.requests.length).toBeGreaterThan(acquired);
    expect(fixture.countOf('render.three.surface.opened')).toBe(2);

    fixture.renderer.destroy();
    releaseParkedRenderer(mock.element);
    mock.element.remove();
  });

  it('is held per canvas, so a second canvas takes its own', () => {
    const one = createMockCanvas({ context: createMockWebGLContext().gl });
    const two = createMockCanvas({ context: createMockWebGLContext().gl });

    document.body.append(one.element, two.element);

    const first = over(one.element);
    const second = over(two.element);

    expect(first.countOf('render.three.surface.opened')).toBe(1);
    expect(second.countOf('render.three.surface.opened')).toBe(1);
    expect(second.countOf('render.three.surface.reused')).toBe(0);

    // A renderer still mounted is not parked, so neither can be released yet.
    expect(releaseParkedRenderer(one.element)).toBe(false);
    expect(releaseParkedRenderer(two.element)).toBe(false);

    first.renderer.destroy();

    // Releasing one canvas leaves the other's renderer alone.
    expect(releaseParkedRenderer(one.element)).toBe(true);
    expect(releaseParkedRenderer(one.element)).toBe(false);

    second.renderer.destroy();

    expect(releaseParkedRenderer(two.element)).toBe(true);

    one.element.remove();
    two.element.remove();
  });

  it('answers falsely for anything that is not a canvas', () => {
    expect(releaseParkedRenderer(null)).toBe(false);
    expect(releaseParkedRenderer(undefined)).toBe(false);
    expect(releaseParkedRenderer(document.createElement('div'))).toBe(false);
  });

  /**
   * The two flags `DL-THREE-05` resets, and the value it resets them to.
   *
   * Three.js writes both through a CACHED `pixelStorei`, so a write made behind
   * the renderer's back leaves its cache claiming a value the context no longer
   * carries — which mirrors every numeral texture uploaded after a re-mount.
   * DL-THREE-07.
   */
  const UNPACK_FLAGS = ['UNPACK_FLIP_Y_WEBGL', 'UNPACK_PREMULTIPLY_ALPHA_WEBGL'];

  /** Every unpack write this context took after `from`. */
  const unpackWritesAfter = (
    context: MockWebGLContext,
    from: number,
  ): readonly { readonly parameter: string; readonly value: unknown }[] =>
    context.pixelStore
      .slice(from)
      .filter((write) => UNPACK_FLAGS.includes(write.parameter));

  it('writes no pixel-store state when it parks', () => {
    const context = createMockWebGLContext();
    const mock = createMockCanvas({ context: context.gl });

    document.body.append(mock.element);

    const fixture = over(mock.element);

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    const wroteBefore = context.pixelStore.length;

    fixture.renderer.unmount();

    // The park hands the context to nobody but the instance that wrote it, and
    // that instance's own cache is the record of what it wrote. What a genuine
    // release writes instead is pinned by the unpack-state suite below.
    expect(unpackWritesAfter(context, wroteBefore)).toEqual([]);

    expect(fixture.renderer.mount()).toBe(true);

    fixture.renderer.destroy();
    releaseParkedRenderer(mock.element);
    mock.element.remove();
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

  // The two effect controllers were created with the DESKTOP defaults and
  // were never re-measured, so a board whose geometry differed from the desktop
  // 4x4 sprayed the wrong number of cell pitches and punched by the wrong share
  // of its own field. DL-THREE-10, DL-PARTICLE-07, DL-CAMERA-05.
  it('re-measures the burst spread for a board size that changed', () => {
    const fixture = harness();

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    // Nothing is re-measured while the geometry stands: both controllers are
    // constructed against the geometry the board was mounted at.
    expect(fixture.countOf('render.particles.geometry')).toBe(0);
    expect(fixture.countOf('render.camera.geometry')).toBe(0);

    // A board-mutating relic shrinks the board mid-run, which rebuilds the
    // geometry: the CELL PITCH moves, so the spray is re-measured. The FIELD
    // measure does not — the board is drawn across the same field whatever its
    // size — so the punch's share is left exactly as it was.
    fixture.renderer.render(commitOf(3, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    expect(fixture.renderer.readStats().boardSize).toBe(3);
    expect(fixture.countOf('render.particles.geometry')).toBe(1);
    expect(fixture.countOf('render.camera.geometry')).toBe(0);

    // Neither controller is pinned, so nothing was refused.
    expect(fixture.countOf('render.particles.geometry.pinned')).toBe(0);
    expect(fixture.countOf('render.camera.geometry.pinned')).toBe(0);

    fixture.renderer.destroy();
  });

  it('re-measures once when a rebuild changes the scale, and not again', () => {
    const scale = stubScaleQuery();

    try {
      const fixture = harness();

      fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
      drain(fixture.renderer);

      // The breakpoint crossing rebuilds the board AT THE SCALE NOW IN FORCE:
      // `DL-THREE-08` tracks the scale the factory was constructed at and
      // rebuilds it whenever the scale in force differs, so the mobile rebuild
      // resolves the mobile lengths rather than keeping the desktop ones. A
      // scale change moves the CELL PITCH and the FIELD together — the mobile
      // board is a smaller board, not the same board re-divided — so each
      // controller re-measures exactly ONCE, against the magnitude that moved.
      // That is the difference from a board-size change at one scale, where the
      // pitch moves and the field does not.
      scale.cross();
      drain(fixture.renderer);

      expect(fixture.renderer.readStats().boardsBuilt).toBe(2);
      expect(fixture.countOf('render.particles.geometry')).toBe(1);
      expect(fixture.countOf('render.camera.geometry')).toBe(1);

      // No churn: draining again re-measures nothing, because `useGeometry`
      // reports only a spread that actually moved.
      drain(fixture.renderer);

      expect(fixture.renderer.readStats().boardsBuilt).toBe(2);
      expect(fixture.countOf('render.particles.geometry')).toBe(1);
      expect(fixture.countOf('render.camera.geometry')).toBe(1);
      expect(fixture.countOf('render.particles.geometry.pinned')).toBe(0);
      expect(fixture.countOf('render.camera.geometry.pinned')).toBe(0);

      fixture.renderer.destroy();
    } finally {
      scale.restore();
    }
  });

  it('seeds both controllers from the geometry the board mounted at', () => {
    const numberOnlyHost = document.createElement('div');

    numberOnlyHost.id = 'board-number-only';
    numberOnlyHost.hidden = true;

    const mock = createMockCanvas({ context: createMockWebGLContext().gl });

    document.body.append(numberOnlyHost, mock.element);

    const measured: RenderDetail[] = [];
    const renderer = createThreeRenderer({
      canvas: mock.element,
      numberOnlyHost,
      ownerDocument: document,

      // The scale a phone-sized session mounts at, stated rather than queried.
      scale: 'mobile',
      reporter: {
        onDiagnostic: (): void => {},
        onCount: (count): void => {
          if (count.name === 'render.particles.geometry') {
            measured.push(count.detail ?? {});
          }
        },
        onTiming: (): void => {},
      },
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);
    renderer.render(commitOf(3, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    // MOBILE LENGTHS ON BOTH SIDES of the re-measure: the pitch it moved FROM is
    // the mobile 4-cell pitch of 67.5 and not the desktop 121.25 the default
    // carries, which is the proof the construction seeding reached the
    // controller; the pitch it moved TO is the mobile 3-cell pitch of 90.
    expect(measured).toHaveLength(1);
    expect(measured[0]?.previous).toBeCloseTo(67.5, 6);
    expect(measured[0]?.spread).toBeCloseTo(90, 6);
    expect(measured[0]?.gridRowCells).toBe(3);

    renderer.destroy();
  });
});

/**
 * The geometry the board count says the board was actually laid out with.
 *
 * @param fixture Harness to read.
 * @returns The lengths, as numbers.
 */
const laidOutGeometry = (
  fixture: Harness,
): {
  readonly scale: string;
  readonly factoryScale: string;
  readonly cellPitch: number;
  readonly tileSize: number;
  readonly tileBoxSize: number;
  readonly fieldWidth: number;
  readonly gridSpacing: number;
  readonly cameraDistance: number;
  readonly boardSize: number;
} => {
  const detail = fixture.detailOf('render.three.board');

  expect(detail).toBeDefined();

  return {
    scale: String(detail?.scale),
    factoryScale: String(detail?.factoryScale),
    cellPitch: Number(detail?.cellPitch),
    tileSize: Number(detail?.tileSize),
    tileBoxSize: Number(detail?.tileBoxSize),
    fieldWidth: Number(detail?.fieldWidth),
    gridSpacing: Number(detail?.gridSpacing),
    cameraDistance: Number(detail?.cameraDistance),
    boardSize: Number(detail?.boardSize),
  };
};

/* ==========================================================================
 * THE GEOMETRY BEHIND THE SCALE'S NAME
 *
 * `TileMeshFactory` resolves the cell pitch, the tile footprint, the extrusion
 * depth and the numeral font size from the scale handed to it ONCE, at
 * construction, and publishes no way to change it. The renderer reported the
 * LIVE scale from `resolveScale()`, so a breakpoint crossing rebuilt the board
 * and reported `'mobile'` while every length in it was still the desktop one;
 * and the context-restore closure captured the size and scale `mount()` had
 * read, so a restore after a crossing came back at the mount-time pair.
 *
 * These cases read the lengths the board was ACTUALLY laid out with, from the
 * board count's own detail, and compare them against `resolveBoardGeometry()`
 * for the scale in force. A stats-only assertion passed throughout. DL-THREE-08.
 * ========================================================================== */

describe('the geometry behind the scale name', () => {
  it('lays the board out with the desktop lengths on mount', () => {
    const fixture = harness();
    const expected = resolveBoardGeometry(4, 'desktop');
    const actual = laidOutGeometry(fixture);

    expect(actual.scale).toBe('desktop');
    expect(actual.factoryScale).toBe('desktop');
    expect(actual.tileSize).toBeCloseTo(expected.tileSize, 6);
    expect(actual.tileBoxSize).toBe(expected.tileBoxSize);
    expect(actual.fieldWidth).toBe(expected.fieldWidth);
    expect(actual.gridSpacing).toBe(expected.gridSpacing);
    expect(actual.cellPitch).toBeCloseTo(
      expected.tileBoxSize + expected.gridSpacing,
      6,
    );

    fixture.renderer.destroy();
  });

  it('re-lays every length when the breakpoint is crossed', () => {
    const scale = stubScaleQuery();

    try {
      const fixture = harness();
      const desktop = resolveBoardGeometry(4, 'desktop');
      const mobile = resolveBoardGeometry(4, 'mobile');

      // The two scales must genuinely differ, or the assertions below would
      // hold for a factory that was never rebuilt.
      expect(mobile.tileBoxSize).not.toBe(desktop.tileBoxSize);
      expect(mobile.fieldWidth).not.toBe(desktop.fieldWidth);
      expect(mobile.gridSpacing).not.toBe(desktop.gridSpacing);

      fixture.renderer.render(
        commitOf(4, [
          { x: 0, y: 0, value: 2 },
          { x: 1, y: 1, value: 4 },
        ]),
      );
      drain(fixture.renderer);

      expect(laidOutGeometry(fixture).tileBoxSize).toBe(desktop.tileBoxSize);

      const desktopFraming = laidOutGeometry(fixture).cameraDistance;

      scale.cross();
      drain(fixture.renderer);

      const crossed = laidOutGeometry(fixture);

      // THE FACTORY ITSELF WAS REBUILT, so the lengths follow the name.
      expect(crossed.scale).toBe('mobile');
      expect(crossed.factoryScale).toBe('mobile');
      expect(crossed.tileSize).toBeCloseTo(mobile.tileSize, 6);
      expect(crossed.tileBoxSize).toBe(mobile.tileBoxSize);
      expect(crossed.fieldWidth).toBe(mobile.fieldWidth);
      expect(crossed.gridSpacing).toBe(mobile.gridSpacing);
      expect(crossed.cellPitch).toBeCloseTo(
        mobile.tileBoxSize + mobile.gridSpacing,
        6,
      );

      // AND THE CAMERA WAS REFRAMED for the smaller field.
      expect(crossed.cameraDistance).not.toBeCloseTo(desktopFraming, 6);

      // The blocks the commit drew are still drawn, at the new scale.
      expect(fixture.renderer.readStats().liveTiles).toBe(2);

      // And back, so nothing about this is one-directional.
      scale.cross();
      drain(fixture.renderer);

      const returned = laidOutGeometry(fixture);

      expect(returned.scale).toBe('desktop');
      expect(returned.factoryScale).toBe('desktop');
      expect(returned.tileBoxSize).toBe(desktop.tileBoxSize);
      expect(returned.fieldWidth).toBe(desktop.fieldWidth);
      expect(returned.cameraDistance).toBeCloseTo(desktopFraming, 6);
      expect(fixture.renderer.readStats().liveTiles).toBe(2);

      fixture.renderer.destroy();
    } finally {
      scale.restore();
    }
  });

  it('restores a lost context at the scale in force, not the mounted one',
    () => {
      const scale = stubScaleQuery();

      try {
        const fixture = harness();
        const mobile = resolveBoardGeometry(4, 'mobile');

        fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
        drain(fixture.renderer);

        expect(laidOutGeometry(fixture).factoryScale).toBe('desktop');

        // Cross to mobile, THEN lose and restore the context. The restore reads
        // the size and scale in force rather than the pair `mount()` read, so
        // the board comes back mobile-sized on a mobile viewport.
        scale.cross();
        drain(fixture.renderer);

        expect(laidOutGeometry(fixture).factoryScale).toBe('mobile');

        fixture.emit('webglcontextlost');

        expect(fixture.renderer.readStats().contextLost).toBe(true);

        fixture.emit('webglcontextrestored');
        drain(fixture.renderer);

        expect(fixture.renderer.readStats().contextLost).toBe(false);
        expect(fixture.renderer.readStats().contextRestores).toBe(1);

        const restored = laidOutGeometry(fixture);

        expect(restored.scale).toBe('mobile');
        expect(restored.factoryScale).toBe('mobile');
        expect(restored.tileBoxSize).toBe(mobile.tileBoxSize);
        expect(restored.fieldWidth).toBe(mobile.fieldWidth);
        expect(restored.gridSpacing).toBe(mobile.gridSpacing);
        expect(restored.cellPitch).toBeCloseTo(
          mobile.tileBoxSize + mobile.gridSpacing,
          6,
        );

        fixture.renderer.destroy();
      } finally {
        scale.restore();
      }
    });

  it('restores at the board size in force, not the mounted one', () => {
    // The size half of the same capture: a board rebuilt at another size before
    // the loss must come back at that size.
    const fixture = harness();

    fixture.renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    expect(laidOutGeometry(fixture).boardSize).toBe(4);

    fixture.renderer.render(commitOf(3, [{ x: 0, y: 0, value: 2 }]));
    drain(fixture.renderer);

    expect(laidOutGeometry(fixture).boardSize).toBe(3);
    expect(fixture.renderer.readStats().boardSize).toBe(3);

    fixture.emit('webglcontextlost');
    fixture.emit('webglcontextrestored');
    drain(fixture.renderer);

    expect(fixture.renderer.readStats().contextRestores).toBe(1);
    expect(laidOutGeometry(fixture).boardSize).toBe(3);
    expect(fixture.renderer.readStats().boardSize).toBe(3);

    fixture.renderer.destroy();
  });

  it('rebuilds the board even where the size did not change', () => {
    // The up-to-date short-circuit in `ensureBoard` compares the size alone, so
    // the scale reconciliation has to run BEFORE it — otherwise a crossing at a
    // constant board size kept the board it already had.
    const scale = stubScaleQuery();

    try {
      const fixture = harness();
      const built = fixture.renderer.readStats().boardsBuilt;

      scale.cross();

      expect(fixture.renderer.readStats().boardsBuilt).toBe(built + 1);
      expect(laidOutGeometry(fixture).factoryScale).toBe('mobile');
      expect(laidOutGeometry(fixture).boardSize).toBe(
        fixture.renderer.readStats().boardSize,
      );

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

  it('resets both forbidden flags when the context is given back', () => {
    const context = recordingContext();
    const fixture = harness({ context: context.gl });

    expect(fixture.renderer.mount()).toBe(true);

    // Measured across the RELEASE, where this measured across
    // `destroy()`. A destroy parks the renderer for the next mount over the
    // same canvas and disposes nothing, so it writes no pixel-store state; the
    // parked-renderer suite above pins that silence. DL-THREE-07.
    fixture.renderer.destroy();

    const beforeRelease = context.writes.length;

    expect(releaseParkedRenderer(fixture.canvasElement)).toBe(true);

    // Every numeral is a `CanvasTexture`, whose `flipY` is true, so this
    // renderer left `UNPACK_FLIP_Y_WEBGL` set on a context that outlives it —
    // and the next renderer built on the same canvas begins with the two
    // placeholder 3D uploads for which both flips are forbidden. DL-THREE-05.
    const reset = context.writes.slice(beforeRelease);

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
    fixture.renderer.destroy();

    const beforeRelease = context.writes.length;

    expect(releaseParkedRenderer(fixture.canvasElement)).toBe(true);

    const reset = context.writes.slice(beforeRelease);
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
    fixture.renderer.destroy();

    const beforeRelease = context.writes.length;

    expect(releaseParkedRenderer(fixture.canvasElement)).toBe(true);

    const reset = context.writes.slice(beforeRelease);

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

    // Both paths that reset: the context-loss release inside the renderer, and
    // the module-level release the composition root calls. DL-THREE-07.
    expect(() => {
      fixture.emit('webglcontextlost');
    }).not.toThrow();

    expect(() => {
      fixture.renderer.destroy();
      releaseParkedRenderer(fixture.canvasElement);
    }).not.toThrow();
  });
});

/* ==========================================================================
 * The module-level release REPORTS itself.
 *
 * The instance-level release inside the factory counts
 * `render.three.surface.released` and warns where the unpack reset fails. The
 * module-level one — the release the composition root performs when it disposes
 * the application, and the only release an ordinary session makes — did neither,
 * so the release nothing else counts was the one release nothing counted at all.
 * Decision DL-THREE-12.
 * ========================================================================== */

describe('the release the composition root performs', () => {
  /** A recording sink, and readers over what it received. */
  const sink = (): {
    readonly reporter: RenderReporter;
    readonly counts: { readonly name: string; readonly detail?: unknown }[];
    readonly diagnostics: RenderDiagnostic[];
    readonly detailOf: (name: string) => Record<string, unknown> | undefined;
  } => {
    const counts: { name: string; detail?: unknown }[] = [];
    const diagnostics: RenderDiagnostic[] = [];

    return {
      counts,
      diagnostics,
      reporter: {
        onDiagnostic: (diagnostic): void => {
          diagnostics.push(diagnostic);
        },
        onCount: (count): void => {
          counts.push({ name: count.name, detail: count.detail });
        },
        onTiming: (): void => {},
      },
      detailOf: (name): Record<string, unknown> | undefined => {
        const found = counts.find((entry) => entry.name === name);

        return typeof found?.detail === 'object' && found.detail !== null
          ? (found.detail as Record<string, unknown>)
          : undefined;
      },
    };
  };

  /** Every count of one name the sink received. */
  const countsOf = (
    received: readonly { readonly name: string }[],
    name: string,
  ): number => received.filter((entry) => entry.name === name).length;

  it('counts the release, and the reset it performed with it', () => {
    const reports = sink();
    const fixture = harness();

    expect(fixture.renderer.mount()).toBe(true);
    fixture.renderer.destroy();

    expect(
      releaseParkedRenderer(fixture.canvasElement, reports.reporter),
    ).toBe(true);

    expect(countsOf(reports.counts, 'render.three.surface.released')).toBe(1);
    expect(reports.detailOf('render.three.surface.released')).toEqual({
      unpackReset: true,
    });

    // A clean release warns about nothing.
    expect(reports.diagnostics).toEqual([]);
  });

  it('counts a refusal, naming which refusal it was', () => {
    const reports = sink();
    const fixture = harness();

    expect(fixture.renderer.mount()).toBe(true);

    // Mounted and drawing: not a parked renderer.
    expect(
      releaseParkedRenderer(fixture.canvasElement, reports.reporter),
    ).toBe(false);
    expect(reports.detailOf('render.three.surface.release_refused')).toEqual({
      reason: 'mounted',
    });

    fixture.renderer.destroy();

    // The release itself is reported into a sink of its own, so the refusal
    // counts read below belong to refusals alone.
    expect(releaseParkedRenderer(fixture.canvasElement, sink().reporter)).toBe(
      true,
    );

    const afterRelease = sink();

    // Released already, so there is nothing parked to release.
    expect(
      releaseParkedRenderer(fixture.canvasElement, afterRelease.reporter),
    ).toBe(false);
    expect(
      afterRelease.detailOf('render.three.surface.release_refused'),
    ).toEqual({ reason: 'not-parked' });

    const notACanvas = sink();

    expect(
      releaseParkedRenderer(
        document.createElement('div'),
        notACanvas.reporter,
      ),
    ).toBe(false);
    expect(
      notACanvas.detailOf('render.three.surface.release_refused'),
    ).toEqual({ reason: 'not-a-canvas' });

    // And nothing is counted as released on any refusing path.
    for (const received of [reports, afterRelease, notACanvas]) {
      expect(
        countsOf(received.counts, 'render.three.surface.released'),
      ).toBe(0);
    }
  });

  it('warns where the unpack reset failed, and still releases', () => {
    const reports = sink();
    const mock = createMockWebGLContext();

    // A context whose `pixelStorei` raises is the case the reset's own guard
    // exists for, and its failure is reported here rather than discarded, as
    // the same failure inside the factory is a warning. DL-THREE-05,
    // DL-THREE-12.
    (mock.gl as Record<string, unknown>)['pixelStorei'] = (): never => {
      throw new Error('the context refused the write');
    };

    const fixture = harness({ context: mock.gl });

    expect(fixture.renderer.mount()).toBe(true);
    fixture.renderer.destroy();

    expect(
      releaseParkedRenderer(fixture.canvasElement, reports.reporter),
    ).toBe(true);

    expect(reports.detailOf('render.three.surface.released')).toEqual({
      unpackReset: false,
    });
    expect(
      reports.diagnostics.filter(
        (diagnostic) =>
          diagnostic.level === 'warning' &&
          diagnostic.message.includes('pixel-store unpack state'),
      ),
    ).toHaveLength(1);
  });

  it('reports through a sink that throws without raising into its caller', () => {
    const fixture = harness();

    expect(fixture.renderer.mount()).toBe(true);
    fixture.renderer.destroy();

    // The sink is guarded at this boundary, as every other sink in src/render/
    // is: a faulty reporter cannot turn a release into a failed disposal.
    expect(() =>
      releaseParkedRenderer(fixture.canvasElement, {
        onDiagnostic: (): never => {
          throw new Error('the sink threw');
        },
        onCount: (): never => {
          throw new Error('the sink threw');
        },
        onTiming: (): never => {
          throw new Error('the sink threw');
        },
      }),
    ).not.toThrow();

    // And the release still happened.
    expect(releaseParkedRenderer(fixture.canvasElement)).toBe(false);
  });
});
