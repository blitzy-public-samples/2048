// Contract suite for the number-only renderer's geometry, node reconciliation,
// semantic-surface ownership and subscription lifecycle, AAP R4, R7 and R9.
//
// The numeral textures the WebGL path needs are not involved here: this
// renderer draws DOM nodes, so jsdom carries the whole surface under test.

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import { Grid } from '../../../src/engine/grid';
import { Tile } from '../../../src/engine/tile';
import type { StateCommitEvent } from '../../../src/engine/engine-events';
import {
  EMPTY_RELIC_CONTEXT,
  EMPTY_STAGE_CONTEXT,
} from '../../../src/engine/types';
import {
  createNumberOnlyRenderer,
} from '../../../src/render/number-only-renderer';
import { applyTheme } from '../../../src/theme/themes';

afterEach(() => {
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
): StateCommitEvent => {
  const grid = new Grid(size);

  for (const spec of placed) {
    const tile = new Tile({ x: spec.x, y: spec.y }, spec.value);

    if (spec.from !== undefined) {
      tile.previousPosition = { x: spec.from.x, y: spec.from.y };
    }

    if (spec.merged !== undefined) {
      const [a, b] = spec.merged;
      tile.mergedFrom = [
        new Tile({ x: a.x, y: a.y }, a.value),
        new Tile({ x: b.x, y: b.y }, b.value),
      ];
    }

    grid.insertTile(tile);
  }

  return {
    turn: 1,
    degraded: false,
    board: grid,
    score: 0,
    bestScore: 0,
    over: false,
    won: false,
    terminated: false,
    stage: EMPTY_STAGE_CONTEXT,
    relics: EMPTY_RELIC_CONTEXT,
  };
};

const hostFixture = (): {
  host: HTMLElement;
  parallel: HTMLElement;
  canvas: HTMLElement;
} => {
  const host = document.createElement('div');
  host.id = 'board-number-only';
  host.hidden = true;

  const parallel = document.createElement('div');
  parallel.id = 'board-a11y';
  parallel.setAttribute('role', 'grid');
  parallel.setAttribute('aria-label', 'Game board');
  parallel.setAttribute('aria-busy', 'true');
  parallel.appendChild(document.createElement('div'));

  const canvas = document.createElement('canvas');
  canvas.id = 'board-canvas';

  document.body.append(host, parallel, canvas);

  return { host, parallel, canvas };
};

const drain = (renderer: { frame(): boolean }): void => {
  let guard = 0;

  while (renderer.frame() && guard < 8) {
    guard += 1;
  }
};

const tilesOf = (host: HTMLElement): HTMLElement[] =>
  Array.from(host.querySelectorAll<HTMLElement>('.tile'));

describe('F-30 semantic-surface exclusivity', () => {
  it('hides the parallel board once it has a lattice, without emptying it', () => {
    const { host, parallel } = hostFixture();

    // A cell the OTHER layer owns. Removing it left that layer holding a
    // detached node while its own `isMounted` still reported `true`, and
    // restoring attributes alone never gave it back.
    const foreignCell = document.createElement('div');

    foreignCell.setAttribute('role', 'gridcell');
    parallel.appendChild(foreignCell);

    const renderer = createNumberOnlyRenderer({
      host,
      parallelBoard: parallel,
    });

    expect(renderer.mounted).toBe(true);

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    expect(parallel.getAttribute('aria-hidden')).toBe('true');
    expect(parallel.hidden).toBe(true);
    expect(parallel.hasAttribute('aria-busy')).toBe(false);

    // `hidden` takes the subtree out of the rendering tree and the
    // accessibility tree, so nothing has to be removed to take it out of a
    // rotor's reach.
    expect(parallel.contains(foreignCell)).toBe(true);

    const grids = document.querySelectorAll(
      '[role="grid"]:not([aria-hidden="true"])',
    );

    expect(grids.length).toBe(1);
    expect(host.contains(grids[0]!)).toBe(true);

    renderer.dispose();
  });

  it('leaves the parallel board alone while the lattice is deferred', () => {
    const { host, parallel } = hostFixture();
    const renderer = createNumberOnlyRenderer({
      host,
      parallelBoard: parallel,
    });

    // No configured size was handed in, so the lattice waits for the first
    // commit.
    expect(parallel.hasAttribute('aria-hidden')).toBe(false);
    expect(parallel.hidden).toBe(false);
    expect(parallel.getAttribute('aria-busy')).toBe('true');

    renderer.dispose();
  });

  it('claims the parallel board at mount when a size is configured', () => {
    const { host, parallel } = hostFixture();
    const renderer = createNumberOnlyRenderer({
      host,
      parallelBoard: parallel,
      config: createDefaultRulesConfig(),
    });

    expect(parallel.getAttribute('aria-hidden')).toBe('true');
    expect(parallel.hidden).toBe(true);

    renderer.dispose();
  });

  it('claims the parallel board only once across a resize', () => {
    const { host, parallel } = hostFixture();
    const renderer = createNumberOnlyRenderer({
      host,
      parallelBoard: parallel,
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);
    renderer.render(commitOf(5, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    renderer.unmount();

    // Restored to what it shipped as, not to a state a second claim recorded
    // after the first had already overwritten it.
    expect(parallel.hasAttribute('aria-hidden')).toBe(false);
    expect(parallel.getAttribute('aria-busy')).toBe('true');
    expect(parallel.hidden).toBe(false);

    renderer.dispose();
  });

  it('restores every attribute it changed on unmount', () => {
    const { host, parallel } = hostFixture();
    const renderer = createNumberOnlyRenderer({
      host,
      parallelBoard: parallel,
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);
    renderer.unmount();

    expect(parallel.hasAttribute('aria-hidden')).toBe(false);
    expect(parallel.getAttribute('aria-busy')).toBe('true');
    expect(parallel.hidden).toBe(false);

    renderer.dispose();
  });

  it('restores the parallel board on dispose', () => {
    const { host, parallel } = hostFixture();
    const renderer = createNumberOnlyRenderer({
      host,
      parallelBoard: parallel,
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);
    renderer.dispose();

    expect(parallel.hasAttribute('aria-hidden')).toBe(false);
    expect(parallel.hidden).toBe(false);
  });
});

describe('F-09 board geometry is configured, not compiled', () => {
  for (const size of [3, 4, 5, 6]) {
    it(`writes a distinct transform for every cell of ${size}x${size}`, () => {
      const { host } = hostFixture();
      const renderer = createNumberOnlyRenderer({ host });

      const placed: Placed[] = [];

      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          placed.push({ x, y, value: 2 });
        }
      }

      renderer.render(commitOf(size, placed));
      drain(renderer);

      expect(host.getAttribute('data-board-size')).toBe(String(size));

      const transforms = tilesOf(host).map((tile) => tile.style.transform);

      expect(transforms.length).toBe(size * size);
      expect(
        transforms.every((value) => /^translate\(-?\d/.test(value)),
      ).toBe(true);
      expect(new Set(transforms).size).toBe(size * size);

      renderer.dispose();
    });
  }

  it('places cell (0,0) at the origin and steps monotonically', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(
      commitOf(5, [
        { x: 0, y: 0, value: 2 },
        { x: 1, y: 0, value: 4 },
        { x: 4, y: 0, value: 8 },
      ]),
    );
    drain(renderer);

    const read = (value: number): number => {
      const tile = tilesOf(host).find(
        (element) => element.textContent === String(value),
      );

      const match = /translate\((-?[\d.]+)px/.exec(tile?.style.transform ?? '');

      return Number(match?.[1] ?? Number.NaN);
    };

    expect(read(2)).toBe(0);
    expect(read(4)).toBeGreaterThan(0);
    expect(read(8)).toBeGreaterThan(read(4));

    renderer.dispose();
  });

  it('publishes every tile presentation property the stylesheet reads', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 128 }]));
    drain(renderer);

    // Written on the `.tile` wrapper, which is what `.tile-inner` inherits
    // them from; style/main.scss reads each through a `var(--x,
    // var(--x-compiled, …))` chain, so a property the renderer never writes
    // silently falls back to the compiled four-wide ramp.
    const tile = tilesOf(host)[0];

    expect(tile).toBeDefined();
    expect(tile!.style.getPropertyValue('--tile-fill')).toBe('#edcf72');
    expect(tile!.style.getPropertyValue('--tile-numeral')).toBe('#f9f6f2');
    expect(tile!.style.getPropertyValue('--tile-numeral-size')).toBe('45px');
    expect(tile!.style.getPropertyValue('--tile-numeral-size-mobile')).toBe(
      '25px',
    );

    renderer.dispose();
  });

  it('steps the numeral size down as the value gains digits', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(
      commitOf(4, [
        { x: 0, y: 0, value: 2 },
        { x: 1, y: 0, value: 128 },
        { x: 2, y: 0, value: 1024 },
      ]),
    );
    drain(renderer);

    const sizeOf = (value: number): string => {
      const tile = tilesOf(host).find(
        (element) => element.textContent === String(value),
      );

      return tile?.style.getPropertyValue('--tile-numeral-size') ?? '';
    };

    expect(sizeOf(2)).toBe('55px');
    expect(sizeOf(128)).toBe('45px');
    expect(sizeOf(1024)).toBe('35px');

    renderer.dispose();
  });

  it('publishes the board size as a custom property', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(3, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    expect(host.style.getPropertyValue('--board-size')).toBe('3');

    renderer.dispose();
  });
});

describe('F-17 tile nodes are reconciled, not rebuilt', () => {
  it('retains the same node for a tile that did not change', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    const first = tilesOf(host)[0]!;

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    expect(tilesOf(host)[0]).toBe(first);
  });

  it('retains a moved tile\'s node, and rewrites its transform', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    const first = tilesOf(host)[0]!;
    const before = first.style.transform;

    renderer.render(
      commitOf(4, [{ x: 3, y: 0, value: 2, from: { x: 0, y: 0 } }]),
    );
    drain(renderer);

    const after = tilesOf(host).filter((tile) => tile.textContent === '2');

    expect(after).toContain(first);
    expect(first.style.transform).not.toBe(before);
    expect(first.classList.contains('tile-position-4-1')).toBe(true);

    renderer.dispose();
  });

  it('clears a stale animation class off a retained node', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    const spawned = tilesOf(host)[0]!;
    expect(spawned.classList.contains('tile-new')).toBe(true);

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    expect(tilesOf(host)[0]).toBe(spawned);
    expect(spawned.classList.contains('tile-new')).toBe(false);
  });

  it('builds a fresh node for a merged tile so pop retriggers', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(
      commitOf(4, [
        { x: 0, y: 0, value: 2 },
        { x: 1, y: 0, value: 2 },
      ]),
    );
    drain(renderer);

    const before = new Set(tilesOf(host));

    renderer.render(
      commitOf(4, [
        {
          x: 0,
          y: 0,
          value: 4,
          merged: [
            { x: 0, y: 0, value: 2 },
            { x: 1, y: 0, value: 2 },
          ],
        },
      ]),
    );
    drain(renderer);

    const merged = tilesOf(host).find((tile) => tile.textContent === '4');

    expect(merged).toBeDefined();
    expect(before.has(merged!)).toBe(false);
    expect(merged!.classList.contains('tile-merged')).toBe(true);

    renderer.dispose();
  });

  it('removes a tile that left the board', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(
      commitOf(4, [
        { x: 0, y: 0, value: 2 },
        { x: 2, y: 2, value: 8 },
      ]),
    );
    drain(renderer);

    expect(tilesOf(host).length).toBe(2);

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    expect(tilesOf(host).length).toBe(1);
    expect(tilesOf(host)[0]!.textContent).toBe('2');

    renderer.dispose();
  });

  it('does not retain a node whose value changed in place', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    const first = tilesOf(host)[0]!;

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 4 }]));
    drain(renderer);

    const now = tilesOf(host);

    expect(now.length).toBe(1);
    expect(now[0]).not.toBe(first);
    expect(now[0]!.textContent).toBe('4');

    renderer.dispose();
  });

  it('starts from an empty retention table after a remount', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    renderer.unmount();
    expect(renderer.mount(host)).toBe(true);

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    const now = tilesOf(host);

    expect(now.length).toBe(1);
    expect(host.contains(now[0]!)).toBe(true);

    renderer.dispose();
  });
});

describe('F-23 subscribe() after dispose()', () => {
  const emitterStub = (): {
    events: Parameters<
      ReturnType<typeof createNumberOnlyRenderer>['subscribe']
    >[0];
    count(): number;
  } => {
    let listeners = 0;

    return {
      events: {
        on: (): (() => void) => {
          listeners += 1;

          return (): void => {
            listeners -= 1;
          };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      count: (): number => listeners,
    };
  };

  it('registers nothing and returns a releasable no-op', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });
    const stub = emitterStub();

    renderer.dispose();

    const release = renderer.subscribe(stub.events);

    expect(stub.count()).toBe(0);
    expect(() => release()).not.toThrow();
    expect(() => release()).not.toThrow();
  });

  it('releases immediately when registration races disposal', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    let listeners = 0;

    const racing = {
      on: (): (() => void) => {
        listeners += 1;
        renderer.dispose();

        return (): void => {
          listeners -= 1;
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const release = renderer.subscribe(racing);

    expect(listeners).toBe(0);
    expect(() => release()).not.toThrow();
  });

  it('ignores a commit after dispose', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);
    renderer.dispose();

    expect(() =>
      renderer.render(commitOf(4, [{ x: 1, y: 1, value: 8 }])),
    ).not.toThrow();
    expect(renderer.frame()).toBe(false);
  });
});

describe('the rendered snapshot carries the unestablished-status flag', () => {
  it('reports what the commit reported, and clears with it', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render({
      ...commitOf(4, [{ x: 0, y: 0, value: 2 }]),
      degraded: true,
    });
    drain(renderer);

    // `RenderedBoard` is the shape src/ui/a11y reads, so dropping the flag
    // left the number-only presentation — which is also the WebGL fallback and
    // the accessible rendering mode — unable to say the verdict was
    // unconfirmed.
    expect(renderer.readRenderedBoard()?.degraded).toBe(true);

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    expect(renderer.readRenderedBoard()?.degraded).toBe(false);

    renderer.dispose();
  });
});
