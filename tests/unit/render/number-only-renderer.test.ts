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

describe('F-05 the focused board coordinate survives a rebuild', () => {
  /** Every cell of the lattice, in row-major order. */
  const cellsOf = (host: HTMLElement): HTMLElement[] =>
    Array.from(host.querySelectorAll<HTMLElement>('.grid-cell'));

  /** The index of the one cell carrying the tab stop, or `-1`. */
  const tabStopIndex = (host: HTMLElement): number =>
    cellsOf(host).findIndex((cell) => cell.getAttribute('tabindex') === '0');

  it('keeps the tab stop and focus on the same coordinate across a resize', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    // Column 2, row 1 of a four-wide board.
    cellsOf(host).at(1 * 4 + 2)?.focus();

    expect(tabStopIndex(host)).toBe(6);

    renderer.render(commitOf(5, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    // The rebuild discards every node, so the coordinate — not the index — is
    // what carries: column 2, row 1 of a five-wide board. DL-FOCUS-04.
    expect(tabStopIndex(host)).toBe(1 * 5 + 2);
    expect(document.activeElement).toBe(cellsOf(host).at(1 * 5 + 2));

    renderer.dispose();
  });

  it('clamps a carried coordinate into a board that shrank under it', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);
    cellsOf(host).at(3 * 4 + 3)?.focus();

    renderer.render(commitOf(3, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    // The far corner of a three-wide board, which is the nearest cell to the
    // one a cursed relic took away.
    expect(tabStopIndex(host)).toBe(2 * 3 + 2);
    expect(document.activeElement).toBe(cellsOf(host).at(8));

    renderer.dispose();
  });

  it('moves no focus when the rebuild happened with focus elsewhere', () => {
    const { host } = hostFixture();
    const elsewhere = document.createElement('button');

    document.body.appendChild(elsewhere);

    const renderer = createNumberOnlyRenderer({ host });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);
    cellsOf(host).at(2)?.focus();
    elsewhere.focus();

    renderer.render(commitOf(4, [{ x: 1, y: 1, value: 4 }]));
    renderer.render(commitOf(5, [{ x: 1, y: 1, value: 4 }]));
    drain(renderer);

    // The coordinate is still adopted, so a later Tab opens on it; focus itself
    // stays where the player put it.
    expect(tabStopIndex(host)).toBe(2);
    expect(document.activeElement).toBe(elsewhere);

    renderer.dispose();
  });
});

describe('F-05 the coordinate crosses the parallel-board handoff', () => {
  /** A parallel board whose cells carry the layer's coordinate attributes. */
  const parallelWithCells = (size: number): HTMLElement => {
    const board = document.createElement('div');

    board.id = 'board-a11y';
    board.setAttribute('role', 'grid');
    board.setAttribute('aria-busy', 'true');

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const cell = document.createElement('div');

        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('data-cell-x', String(x));
        cell.setAttribute('data-cell-y', String(y));
        cell.setAttribute('tabindex', '-1');
        board.appendChild(cell);
      }
    }

    return board;
  };

  /** A lifecycle double recording what the renderer asked of the layer. */
  const layerDouble = (
    withFocusCell: boolean,
  ): {
    layer: {
      isMounted(): boolean;
      mount(): boolean;
      unmount(): void;
      focusCell?(x: number, y: number): boolean;
    };
    calls: string[];
  } => {
    const calls: string[] = [];
    let mounted = true;
    const layer: {
      isMounted(): boolean;
      mount(): boolean;
      unmount(): void;
      focusCell?(x: number, y: number): boolean;
    } = {
      isMounted: (): boolean => mounted,
      mount: (): boolean => {
        mounted = true;
        calls.push('mount');

        return true;
      },
      unmount: (): void => {
        mounted = false;
        calls.push('unmount');
      },
    };

    if (withFocusCell) {
      layer.focusCell = (x: number, y: number): boolean => {
        calls.push(`focusCell:${String(x)},${String(y)}`);

        return true;
      };
    }

    return { layer, calls };
  };

  it('adopts the coordinate the parallel board was focused on', () => {
    const host = document.createElement('div');

    host.id = 'board-number-only';
    host.hidden = true;

    const parallel = parallelWithCells(4);

    document.body.append(host, parallel);

    const handedOver = parallel.children[2 * 4 + 1] as HTMLElement;

    handedOver.setAttribute('tabindex', '0');
    handedOver.focus();

    const renderer = createNumberOnlyRenderer({ host, parallelBoard: parallel });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    const cells = Array.from(host.querySelectorAll<HTMLElement>('.grid-cell'));

    // Column 1, row 2 — read off the layer's own data attributes, so the swap
    // opens the lattice on the cell the player was reading. DL-FOCUS-04.
    expect(cells.at(2 * 4 + 1)?.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(cells.at(2 * 4 + 1));

    renderer.dispose();
  });

  it('hands the coordinate back to the layer taking the board over', () => {
    const { host, parallel } = hostFixture();
    const { layer, calls } = layerDouble(true);
    const renderer = createNumberOnlyRenderer({
      host,
      parallelBoard: parallel,
      parallelBoardLayer: layer,
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    Array.from(host.querySelectorAll<HTMLElement>('.grid-cell'))
      .at(0 * 4 + 2)
      ?.focus();

    renderer.unmount();

    expect(calls).toEqual(['unmount', 'mount', 'focusCell:2,0']);

    renderer.dispose();
  });

  it('takes no focus from elsewhere when it hands the board back', () => {
    const { host, parallel } = hostFixture();
    const elsewhere = document.createElement('button');

    document.body.appendChild(elsewhere);

    const { layer, calls } = layerDouble(true);
    const renderer = createNumberOnlyRenderer({
      host,
      parallelBoard: parallel,
      parallelBoardLayer: layer,
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);
    elsewhere.focus();
    renderer.unmount();

    // The board comes back, and the caret stays in the dialog or on the card
    // the player had reached.
    expect(calls).toEqual(['unmount', 'mount']);
    expect(document.activeElement).toBe(elsewhere);

    renderer.dispose();
  });

  it('restores a layer that publishes no focusCell without throwing', () => {
    const { host, parallel } = hostFixture();
    const { layer, calls } = layerDouble(false);
    const renderer = createNumberOnlyRenderer({
      host,
      parallelBoard: parallel,
      parallelBoardLayer: layer,
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);
    Array.from(host.querySelectorAll<HTMLElement>('.grid-cell')).at(5)?.focus();

    expect(() => {
      renderer.unmount();
    }).not.toThrow();

    // `focusCell` is optional on the port, so the attributes come back and the
    // focus move is simply not made.
    expect(calls).toEqual(['unmount', 'mount']);
    expect(parallel.hasAttribute('aria-hidden')).toBe(false);

    renderer.dispose();
  });
});

describe('F-05 the coordinate crosses a renderer swap', () => {
  const cellsOf = (host: HTMLElement): HTMLElement[] =>
    Array.from(host.querySelectorAll<HTMLElement>('.grid-cell'));

  const tabStopIndex = (host: HTMLElement): number =>
    cellsOf(host).findIndex((cell) => cell.getAttribute('tabindex') === '0');

  it('publishes the cell its tab stop stands on, and whether focus is on it', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({ host });

    // No lattice yet: there is no coordinate to report.
    expect(renderer.focusedCell()).toBeNull();

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    expect(renderer.focusedCell()).toEqual({ x: 0, y: 0, focused: false });

    cellsOf(host).at(2 * 4 + 1)?.focus();

    // Column 1, row 2, and this surface is the one holding focus — which is what
    // lets a caller tell a live caret from a stale tab stop.
    expect(renderer.focusedCell()).toEqual({ x: 1, y: 2, focused: true });

    renderer.dispose();
  });

  it('opens the first lattice on the cell the caller supplied', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({
      host,
      initialCell: { x: 2, y: 1 },
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    // The next Tab lands there. Focus is NOT moved: a swap reached from the
    // settings dialog leaves focus in that dialog. DL-NUMBER-08.
    expect(tabStopIndex(host)).toBe(1 * 4 + 2);
    expect(document.activeElement).not.toBe(cellsOf(host).at(6));

    renderer.dispose();
  });

  it('lets a rebuild s own carry outrank the supplied cell', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({
      host,
      initialCell: { x: 3, y: 3 },
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    expect(tabStopIndex(host)).toBe(15);

    cellsOf(host).at(1)?.focus();
    renderer.render(commitOf(5, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    // Consumed on the first build, so the supplied corner cannot come back over
    // a coordinate the player has since moved to.
    expect(tabStopIndex(host)).toBe(1);

    renderer.dispose();
  });

  it('clamps a supplied cell into the board in force', () => {
    const { host } = hostFixture();
    const renderer = createNumberOnlyRenderer({
      host,
      initialCell: { x: 9, y: 9 },
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    expect(tabStopIndex(host)).toBe(15);

    renderer.dispose();
  });

  it('lets a live handoff outrank the supplied cell', () => {
    const host = document.createElement('div');

    host.id = 'board-number-only';
    host.hidden = true;

    const parallel = document.createElement('div');

    parallel.id = 'board-a11y';
    parallel.setAttribute('role', 'grid');

    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const cell = document.createElement('div');

        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('data-cell-x', String(x));
        cell.setAttribute('data-cell-y', String(y));
        cell.setAttribute('tabindex', '-1');
        parallel.appendChild(cell);
      }
    }

    document.body.append(host, parallel);

    const holding = parallel.children[3 * 4 + 0] as HTMLElement;

    holding.setAttribute('tabindex', '0');
    holding.focus();

    const renderer = createNumberOnlyRenderer({
      host,
      parallelBoard: parallel,
      initialCell: { x: 1, y: 1 },
    });

    renderer.render(commitOf(4, [{ x: 0, y: 0, value: 2 }]));
    drain(renderer);

    // Where focus IS beats where the caller guessed it was: column 0, row 3.
    expect(tabStopIndex(host)).toBe(3 * 4 + 0);
    expect(document.activeElement).toBe(cellsOf(host).at(12));

    renderer.dispose();
  });
});
