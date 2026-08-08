// Contract suite for the scene rig's two public argument boundaries, AAP R7.
//
// WHY THIS SUITE EXISTS
//   `BoardScene` exposes the scene, the camera and the board group alongside the
//   calls that mutate them, and two of those calls trusted arithmetic they had
//   not measured. Neither failure is a rendering artefact: each takes the canvas
//   out for the rest of the session.
//
//   the graph   `Object3D.add` REPARENTS. `mountBoard` refused only a
//               non-object and the board group itself, so mounting `scene` —
//               which is exposed on the same record and IS an ancestor of the
//               board group — moved the scene beneath its own child and made the
//               graph cyclic. The next matrix update or render traversal then
//               recurses until the stack is exhausted.
//   the frustum  `resize` measured width and height individually and then
//               derived the aspect and the four planes from them without
//               measuring either. Two finite positive lengths can still overflow
//               the ratio — `Number.MAX_VALUE / Number.MIN_VALUE` is `Infinity` —
//               and that value was assigned straight onto the orthographic
//               camera, poisoning its projection matrix.
//
// The rig is real throughout. `createScene` builds Three.js objects and needs no
// WebGL context, so every case below runs without a canvas.

import { afterEach, describe, expect, it } from 'vitest';
import { Group, Mesh, Object3D } from 'three';

import { createScene, sceneOptics } from '../../../src/render/scene';
import type { BoardScene } from '../../../src/render/scene';
import type {
  RenderCount,
  RenderDiagnostic,
  RenderReporter,
} from '../../../src/render/webgl-support';
import { applyTheme } from '../../../src/theme/themes';

/* ==========================================================================
 * Harness
 * ========================================================================== */

interface Harness {
  readonly board: BoardScene;
  readonly counts: readonly RenderCount[];
  readonly diagnostics: readonly RenderDiagnostic[];

  /** The names of the counters raised, in order. */
  names(): readonly string[];
}

let active: BoardScene | null = null;

afterEach(() => {
  active?.dispose();
  active = null;
  applyTheme('default');
});

function harness(boardSize = 4): Harness {
  const counts: RenderCount[] = [];
  const diagnostics: RenderDiagnostic[] = [];
  const reporter: RenderReporter = {
    onCount: (count): void => {
      counts.push(count);
    },
    onDiagnostic: (diagnostic): void => {
      diagnostics.push(diagnostic);
    },
    onTiming: (): void => {},
  };
  const board = createScene({ boardSize, reporter });

  active = board;

  return {
    board,
    counts,
    diagnostics,
    names: (): readonly string[] => counts.map((count): string => count.name),
  };
}

/** The four orthographic planes, as one comparable record. */
function planesOf(board: BoardScene): Record<string, number> {
  return {
    left: board.camera.left,
    right: board.camera.right,
    top: board.camera.top,
    bottom: board.camera.bottom,
    near: board.camera.near,
    far: board.camera.far,
  };
}

/** Whether every plane of the camera is a finite number. */
function planesAreFinite(board: BoardScene): boolean {
  return Object.values(planesOf(board)).every((value) =>
    Number.isFinite(value),
  );
}

/* ==========================================================================
 * 1. mountBoard refuses a mount that would make the graph cyclic (F-07)
 * ========================================================================== */

describe('mountBoard', () => {
  it('mounts a factory-owned group', () => {
    const { board, names } = harness();
    const group = new Group();

    expect(board.mountBoard(group)).toBe(true);
    expect(group.parent).toBe(board.boardGroup);
    expect(board.readStats().mountedObjects).toBe(1);
    expect(names()).toContain('render.scene.mounted');
  });

  it('refuses the board group itself', () => {
    const { board } = harness();

    expect(board.mountBoard(board.boardGroup)).toBe(false);
    expect(board.boardGroup.children).toHaveLength(0);
    expect(board.readStats().refused).toBe(1);
  });

  it('refuses the scene, whose child the board group is', () => {
    const { board, diagnostics } = harness();
    const sceneParentBefore = board.boardGroup.parent;

    // The mount that made the graph cyclic: `scene` is exposed on the same
    // record as `boardGroup`, and `add` would have reparented it beneath it.
    expect(board.mountBoard(board.scene)).toBe(false);

    // Neither edge moved: the board group is still the scene's child, and the
    // scene is still nobody's.
    expect(board.boardGroup.parent).toBe(sceneParentBefore);
    expect(board.boardGroup.parent).toBe(board.scene);
    expect(board.scene.parent).toBeNull();
    expect(board.boardGroup.children).toHaveLength(0);
    expect(board.readStats().mountedObjects).toBe(0);
    expect(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.level === 'error' && diagnostic.message.includes('cyclic'),
      ),
    ).toBe(true);
  });

  it('refuses an ancestor further up the chain', () => {
    const { board } = harness();

    // A grandparent of the board group: refusing only the scene would let this
    // one through, and the cycle it creates is the same cycle.
    const grandparent = new Group();

    grandparent.add(board.scene);

    expect(board.mountBoard(grandparent)).toBe(false);
    expect(board.boardGroup.children).toHaveLength(0);
    expect(board.readStats().refused).toBe(1);

    grandparent.remove(board.scene);
  });

  it('renders and updates matrices after a refused ancestor mount', () => {
    const { board } = harness();

    board.mountBoard(board.scene);

    // The traversal a cyclic graph would not survive. It terminates, because the
    // refusal left the graph a tree.
    expect(() => {
      board.scene.updateMatrixWorld(true);
    }).not.toThrow();

    let visited = 0;

    board.scene.traverse((): void => {
      visited += 1;
    });

    expect(visited).toBeGreaterThan(0);
  });

  it('still mounts a legitimate group after a refusal', () => {
    const { board } = harness();
    const group = new Group();

    board.mountBoard(board.scene);

    expect(board.mountBoard(group)).toBe(true);
    expect(board.readStats().mountedObjects).toBe(1);
  });

  it('mounts a descendant of the board group without refusing it', () => {
    const { board } = harness();
    const parent = new Group();
    const child = new Mesh();

    board.mountBoard(parent);
    parent.add(child);

    // Reparenting within the board group creates no cycle, so it is allowed.
    expect(board.mountBoard(child)).toBe(true);
    expect(child.parent).toBe(board.boardGroup);
  });

  it('refuses a value that is not an object at all', () => {
    const { board } = harness();

    expect(board.mountBoard(null as unknown as Object3D)).toBe(false);
    expect(board.mountBoard({} as unknown as Object3D)).toBe(false);
    expect(board.mountBoard('board' as unknown as Object3D)).toBe(false);
    expect(board.boardGroup.children).toHaveLength(0);
    expect(board.readStats().refused).toBe(3);
  });

  it('contains a parenting the graph refuses, leaving the group as it was', () => {
    const { board, diagnostics } = harness();
    const hostile = new Group();

    // An object whose own parent-change hook raises. `add` invokes it, and the
    // throw must not escape into the renderer.
    Object.defineProperty(hostile, 'removeFromParent', {
      value: (): never => {
        throw new Error('refused to leave its parent');
      },
    });

    expect(board.mountBoard(hostile)).toBe(false);
    expect(board.boardGroup.children).toHaveLength(0);
    expect(board.readStats().mountedObjects).toBe(0);
    expect(
      diagnostics.some((diagnostic) => diagnostic.level === 'error'),
    ).toBe(true);
  });

  it('refuses every mount once disposed', () => {
    const { board } = harness();

    board.dispose();

    expect(board.mountBoard(new Group())).toBe(false);
  });
});

/* ==========================================================================
 * 2. resize refuses a viewport that resolves to no usable frustum (F-08)
 * ========================================================================== */

describe('resize', () => {
  it('adopts an ordinary viewport and reprojects', () => {
    const { board, names } = harness();

    expect(board.resize(1280, 960)).toBe(true);
    expect(planesAreFinite(board)).toBe(true);
    expect(board.camera.right).toBeGreaterThan(board.camera.top);
    expect(names()).toContain('render.scene.resized');
  });

  it('inscribes the half-extent in the shorter axis at either orientation', () => {
    const { board } = harness();
    const half = board.readFraming().halfExtent;

    board.resize(1000, 500);

    expect(board.camera.top).toBeCloseTo(half, 6);
    expect(board.camera.right).toBeCloseTo(half * 2, 6);

    board.resize(500, 1000);

    expect(board.camera.right).toBeCloseTo(half, 6);
    expect(board.camera.top).toBeCloseTo(half * 2, 6);
  });

  it('refuses a length that is not a positive finite number', () => {
    const { board } = harness();
    const before = planesOf(board);

    for (const [width, height] of [
      [0, 100],
      [100, 0],
      [-1280, 960],
      [1280, -960],
      [Number.NaN, 960],
      [1280, Number.NaN],
      [Number.POSITIVE_INFINITY, 960],
      [1280, Number.POSITIVE_INFINITY],
    ]) {
      expect(board.resize(width, height)).toBe(false);
    }

    expect(planesOf(board)).toEqual(before);
    expect(board.readStats().resizes).toBe(0);
  });

  it('refuses two finite lengths whose ratio overflows', () => {
    const { board, diagnostics } = harness();
    const before = planesOf(board);

    // Both lengths are finite and positive; the ratio between them is not. This
    // is the assignment that reached the camera as `Infinity`.
    expect(board.resize(Number.MAX_VALUE, Number.MIN_VALUE)).toBe(false);
    expect(planesOf(board)).toEqual(before);
    expect(planesAreFinite(board)).toBe(true);
    expect(board.readStats().resizes).toBe(0);
    expect(board.readStats().refused).toBe(1);
    expect(
      diagnostics.some((diagnostic) =>
        diagnostic.message.includes('aspect ratio'),
      ),
    ).toBe(true);
  });

  it('refuses two finite lengths whose ratio underflows', () => {
    const { board } = harness();
    const before = planesOf(board);

    // The mirror case: the ratio underflows to zero, whose reciprocal — which is
    // what the shorter axis is scaled by — is `Infinity` again.
    expect(board.resize(Number.MIN_VALUE, Number.MAX_VALUE)).toBe(false);
    expect(planesOf(board)).toEqual(before);
    expect(planesAreFinite(board)).toBe(true);
  });

  it('refuses a ratio beyond the documented band in both directions', () => {
    const { board } = harness();
    const before = planesOf(board);

    expect(board.resize(1e6, 1)).toBe(false);
    expect(board.resize(1, 1e6)).toBe(false);
    expect(planesOf(board)).toEqual(before);

    // A wide but plausible viewport is still adopted, so the band refuses the
    // absurd rather than the merely unusual.
    expect(board.resize(3840, 600)).toBe(true);
    expect(planesAreFinite(board)).toBe(true);
  });

  it('keeps the size it held when a later resize is refused', () => {
    const { board } = harness();

    board.resize(1280, 960);

    const adopted = planesOf(board);

    expect(board.resize(Number.MAX_VALUE, Number.MIN_VALUE)).toBe(false);
    expect(planesOf(board)).toEqual(adopted);

    // The rig recovers: the next usable size is adopted as though the refusal
    // had never been offered. A square viewport, so the planes it resolves to
    // differ from the 4:3 ones above rather than coinciding with them.
    expect(board.resize(1024, 1024)).toBe(true);
    expect(planesOf(board)).not.toEqual(adopted);
    expect(planesAreFinite(board)).toBe(true);
    expect(board.readStats().resizes).toBe(2);
  });

  it('holds the near and far planes at the framed depth span', () => {
    const { board } = harness();

    board.resize(1280, 960);

    expect(board.camera.near).toBeCloseTo(
      sceneOptics.distance - sceneOptics.depthSpan,
      6,
    );
    expect(board.camera.far).toBeCloseTo(
      sceneOptics.distance + sceneOptics.depthSpan,
      6,
    );
  });

  it('refuses every resize once disposed', () => {
    const { board } = harness();

    board.resize(1280, 960);

    const adopted = planesOf(board);

    board.dispose();

    expect(board.resize(800, 600)).toBe(false);
    expect(planesOf(board)).toEqual(adopted);
  });
});

/* ==========================================================================
 * 3. reframe keeps the projection finite across a board-size change
 * ========================================================================== */

describe('reframe', () => {
  it('reprojects a new board size and stays finite', () => {
    const { board } = harness();

    board.resize(1280, 960);

    expect(board.reframe(6)).toBe(true);
    expect(board.readFraming().boardSize).toBe(6);
    expect(planesAreFinite(board)).toBe(true);
  });

  it('refuses a board size it cannot frame, leaving the camera alone', () => {
    const { board } = harness();

    board.resize(1280, 960);

    const adopted = planesOf(board);

    expect(board.reframe(Number.NaN)).toBe(false);
    expect(board.reframe(0)).toBe(false);
    expect(planesOf(board)).toEqual(adopted);
    expect(planesAreFinite(board)).toBe(true);
  });
});
