// The scene graph, the camera and the lighting rig of the 2.5D board.
//
// AAP R7. This module owns the three Three.js objects the board is composed
// into and nothing else: it draws no tile, subscribes to no engine event, reads
// no DOM beyond the canvas it is handed, and opens no frame loop.
// src/render/three-renderer.ts composes it with the mesh factory, the tweens,
// the particle system and the camera effects.
//
// WHY AN ORTHOGRAPHIC CAMERA
//   The board is a flat 4x4 lattice drawn as extruded blocks, and every length
//   in the design system is a CSS pixel: the field is $field-width, a cell is
//   $tile-size and the gap is $grid-spacing. An orthographic camera whose frustum
//   is those same pixel units keeps the projected board EXACTLY the size the
//   stylesheet declares, so the 2.5D board occupies the footprint the 2D board
//   occupied and `tilePositionStep` remains the one position authority. A
//   perspective camera would foreshorten each row differently and put the
//   product's own geometry tokens out of force.
//
// THE 2.5D TILT
//   The camera is lifted and tipped by a fixed angle rather than orbiting: the
//   blocks read as extruded rather than flat, while every cell keeps a fixed,
//   predictable screen position — which is what makes the parallel accessibility
//   board's bounding boxes meaningful and what keeps the move tween a straight
//   translation in board space.
//
// LIGHTING
//   Three lights, no shadow maps. A hemisphere light supplies the ambient fill
//   the flat 2D design implies, one directional key light produces the bevel
//   highlight that stands in for `$tile-border-radius`, and a dim directional
//   fill from the opposite side keeps the block sides from going black. Shadow
//   maps are deliberately absent: the 2D design casts no shadow between tiles,
//   and a shadow pass would triple the per-frame cost for an effect the design
//   never had.
//
// This module reads no clock, consumes no randomness and touches no storage.

import {
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  OrthographicCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';

import { isSupportedBoardSize } from '../config/default-config';
import { depthScale } from '../theme/tokens';
import type { GeometryScale } from '../theme/tokens';
import { getActiveTheme, subscribeToThemeChange } from '../theme/themes';
import type { Theme } from '../theme/themes';
import { readThemeColor, toThreeColor } from './tile-materials';
import type { RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  describeRenderError,
} from './webgl-support';

/* ==========================================================================
 * 1. Constants
 * ========================================================================== */

const DIAGNOSTIC_SOURCE = 'render/scene';

/** Counter raised once per scene created. */
const CREATED_METRIC = 'render.scene.created';

/** Counter raised once per resize applied. */
const RESIZED_METRIC = 'render.scene.resized';

/** Counter raised once per reframe. */
const REFRAMED_METRIC = 'render.scene.reframed';

/** Counter raised once per theme applied to the background. */
const THEME_METRIC = 'render.scene.theme';

/** Counter raised once per context loss the renderer reported. */
const CONTEXT_LOST_METRIC = 'render.scene.context_lost';

/** Counter raised once per disposal. */
const DISPOSED_METRIC = 'render.scene.disposed';

/**
 * Tilt of the camera above the board plane, in radians.
 *
 * 0.42 rad is roughly 24 degrees: enough that a block's top face and one side
 * are both visible — which is what makes the board read as extruded — while
 * shallow enough that the far row is not compressed into the near one. It is
 * a fixed value rather than an animated orbit, so a cell's screen position is
 * stable for the whole run.
 */
export const cameraTilt = 0.42;

/**
 * Distance from the board's centre to the camera, in board-space px.
 *
 * Only the orthographic frustum decides the projected size, so this is chosen
 * to clear the tallest block and the particle field rather than to set scale.
 */
export const cameraDistance = 900;

/** Half-depth of the orthographic frustum, in board-space px. */
const FRUSTUM_DEPTH = 4000;

/**
 * Vertical scale applied to the board, so the tilted board projects square.
 *
 * An orthographic camera tipped by `cameraTilt` foreshortens the board's y
 * axis by `cos(cameraTilt)`, which would project the square 4x4 field as a
 * rectangle 8.7% shorter than it is wide. Pre-stretching the board root by the
 * reciprocal cancels that exactly, so the projected footprint is the square
 * footprint style/main.scss lays out — which is what keeps the field inside the
 * container it is drawn in and keeps a cell's projected box aligned with the
 * counterpart cell of the parallel accessibility board.
 *
 * The extrusion is unaffected: block height is along z, so the top faces are
 * still offset and one side of every block still shows.
 */
const BOARD_Y_SCALE = 1 / Math.cos(cameraTilt);

/**
 * Height of a block above the field's top surface, in board-space px.
 *
 * `depthScale.bevel` lifts the block off the plate and `depthScale.tile` is its
 * own extrusion, so this is how far the top face stands above the field.
 */
const BLOCK_HEIGHT = depthScale.bevel + depthScale.tile;

/**
 * How far a block's top face is displaced up the screen by the tilt, in px.
 *
 * The frustum is widened by this and the camera's target raised by half of it,
 * so the top row's top face is inside the frustum and the board stays centred.
 * Without it the top row is clipped by exactly this much.
 */
const EXTRUSION_RISE = BLOCK_HEIGHT * Math.sin(cameraTilt);

/** Intensity of the ambient hemisphere fill. */
const HEMISPHERE_INTENSITY = 2.36;

/** Intensity of the directional key light. */
const KEY_INTENSITY = 1.4;

/** Intensity of the directional fill light. */
const FILL_INTENSITY = 0.4;

/**
 * Direction the key light arrives from, in board space.
 *
 * Up and to the left of the viewer, and tipped toward them, so the bevel
 * highlight lands on the top-left edge of every block — which is where the 1px
 * inset white highlight of the `$glow-opacity` box-shadow sat in the 2D design.
 */
const KEY_DIRECTION = Object.freeze({ x: -0.45, y: 0.85, z: 0.65 });

/**
 * Direction the fill light arrives from, in board space.
 *
 * Behind and below, so it lights the block SIDES the key light leaves dark
 * without adding to the top faces, whose normal it faces away from.
 */
const FILL_DIRECTION = Object.freeze({ x: 0.6, y: 0.35, z: -0.55 });

/**
 * Axis the hemisphere light's sky half lies along, in board space.
 *
 * `+z`, which is the board's own up axis — NOT the default `+y`. A hemisphere
 * light blends its two colours by `0.5 * dot(normal, axis) + 0.5`, so left at
 * the default every face of a board lying in the xy plane would take a 50/50
 * blend of white and the brown ground colour, washing the whole palette out.
 * Along `+z` a top face takes the sky colour alone and a downward face the
 * ground, which is what the flat 2D design implies.
 */
const HEMISPHERE_AXIS = Object.freeze({ x: 0, y: 0, z: 1 });

/** Colour of the hemisphere light's ground half. */
const GROUND_COLOR = '#8f7a66';

/* ==========================================================================
 * 2. Public API
 * ========================================================================== */

/** Construction parameters. Only the canvas is required. */
export interface BoardSceneOptions {
  /** Canvas the WebGL context is obtained from. */
  readonly canvas: HTMLCanvasElement;

  /** Board edge length the frustum is framed for. Defaults to 4. */
  readonly boardSize?: number;

  /**
   * Geometry the frustum is framed from. Defaults to the desktop scale's, and
   * is replaced by `reframe()` when the board size or the scale changes.
   */
  readonly geometry?: GeometryScale;

  /**
   * Device pixel ratio the drawing buffer is sized at. Defaults to the
   * window's, clamped to 2 — above that the buffer grows fourfold for no
   * visible gain on a board of flat colours.
   */
  readonly pixelRatio?: number;

  /** Sink every failure and every counter reports through. */
  readonly reporter?: RenderReporter;
}

/** What one scene created, and what a caller drives it through. */
export interface BoardScene {
  /** The Three.js renderer. */
  readonly renderer: WebGLRenderer;

  /** The scene graph root. */
  readonly scene: Scene;

  /** The orthographic camera the board is projected through. */
  readonly camera: OrthographicCamera;

  /**
   * The group the board's own meshes are parented to, centred on the board's
   * middle so a rotation or a punch acts about the board's centre rather than
   * about its corner.
   */
  readonly boardRoot: Group;

  /**
   * Sizes the drawing buffer and the frustum to a CSS pixel size.
   *
   * @param width CSS width, in px.
   * @param height CSS height, in px.
   * @returns Whether anything changed.
   */
  resize(width: number, height: number): boolean;

  /**
   * Reframes the camera for a board size and geometry.
   *
   * Called when a board-mutating relic changes the edge length and when the
   * scale changes at the mobile breakpoint.
   *
   * @param boardSize Cells per row.
   * @param geometry Geometry resolved for that size and scale.
   * @returns Whether the frame changed.
   */
  reframe(boardSize: number, geometry: GeometryScale): boolean;

  /** Draws one frame. */
  render(): void;

  /** Applies a theme's page background to the clear colour. */
  applyTheme(theme?: Theme): void;

  /** Whether the WebGL context has been reported lost. */
  isContextLost(): boolean;

  /**
   * Releases the renderer, both lights and the theme subscription. Three.js
   * frees no GPU resource on collection, so this is the call a teardown makes.
   */
  dispose(): void;
}

/* ==========================================================================
 * 3. Construction
 * ========================================================================== */

/** Highest device pixel ratio the drawing buffer is sized at. */
const MAX_PIXEL_RATIO = 2;

function resolvePixelRatio(supplied: number | undefined): number {
  const candidate =
    supplied ??
    (typeof globalThis.devicePixelRatio === 'number'
      ? globalThis.devicePixelRatio
      : 1);

  if (!Number.isFinite(candidate) || candidate <= 0) {
    return 1;
  }

  return Math.min(candidate, MAX_PIXEL_RATIO);
}

/**
 * The half-extent of the frustum, in board-space px, for one board.
 *
 * The box framed is the CONTENT BOX of `.game-container`, which is
 * `$field-width` less the container's `$grid-spacing` padding on both sides —
 * because that is the box `#board-host`, and therefore the canvas, occupies.
 * One board-space px is then one CSS px, so the projected board is exactly the
 * size the stylesheet declares and the field's outer ring is drawn by the
 * container's own background exactly as it was in the 2D board.
 *
 * `EXTRUSION_RISE` is added so the top row's top face, which the tilt lifts up
 * the screen, is inside the frustum rather than clipped by it.
 *
 * The field is square, so one half-extent frames both axes; the aspect ratio of
 * the canvas widens the horizontal half in `resize`.
 */
function frustumHalfExtent(geometry: GeometryScale): number {
  const contentBox = geometry.fieldWidth - geometry.gridSpacing * 2;

  return contentBox / 2 + EXTRUSION_RISE / 2;
}

/**
 * Creates the scene, the camera and the lighting rig.
 *
 * The WebGL context is requested here and nowhere else, so a caller that has
 * already probed for support decides whether to call this at all.
 *
 * @param options Canvas, board size, geometry, pixel ratio and report sink.
 * @returns A frozen scene.
 * @throws Error when the canvas yields no WebGL context. A caller probes with
 *   `probeWebGLSupport` first and selects the number-only renderer instead.
 *
 * @example
 * ```ts
 * const scene = createBoardScene({ canvas });
 * scene.resize(500, 500);
 * scene.render();
 * ```
 */
export function createBoardScene(options: BoardSceneOptions): BoardScene {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );

  const renderer = new WebGLRenderer({
    canvas: options.canvas,
    antialias: true,

    // TRANSPARENT, deliberately. The canvas is laid over `.game-container`,
    // whose background is `$game-container-background` — the same colour the
    // board field is drawn in — and the tilted board does not fill the square
    // canvas to the last pixel. Clearing to an opaque colour would paint those
    // few pixels in that colour instead of letting the container's own
    // background show, which is what the 2D board had there.
    alpha: true,
  });

  renderer.setPixelRatio(resolvePixelRatio(options.pixelRatio));

  // Shadow maps are deliberately off: the 2D design casts no shadow between
  // tiles, so a shadow pass would cost per frame for an effect it never had.
  renderer.shadowMap.enabled = false;

  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 1, FRUSTUM_DEPTH);
  const boardRoot = new Group();

  scene.add(boardRoot);

  const hemisphere = new HemisphereLight(
    0xffffff,
    new Color(GROUND_COLOR).getHex(),
    HEMISPHERE_INTENSITY,
  );
  const key = new DirectionalLight(0xffffff, KEY_INTENSITY);
  const fill = new DirectionalLight(0xffffff, FILL_INTENSITY);

  key.position.set(KEY_DIRECTION.x, KEY_DIRECTION.y, KEY_DIRECTION.z);
  fill.position.set(FILL_DIRECTION.x, FILL_DIRECTION.y, FILL_DIRECTION.z);
  hemisphere.position.set(
    HEMISPHERE_AXIS.x,
    HEMISPHERE_AXIS.y,
    HEMISPHERE_AXIS.z,
  );

  scene.add(hemisphere, key, fill);

  // The tilt's vertical foreshortening, cancelled on the way in.
  boardRoot.scale.set(1, BOARD_Y_SCALE, 1);

  let boardSize = options.boardSize ?? 0;
  let geometry: GeometryScale | null = options.geometry ?? null;
  let width = 0;
  let height = 0;
  let contextLost = false;

  const target = new Vector3();

  /**
   * Places the camera above and in front of the board's centre, looking at it.
   *
   * The tilt is applied as a position rather than a rotation so `lookAt` keeps
   * the up axis consistent: the camera is lifted by `sin(tilt)` and pulled back
   * by `cos(tilt)`, both scaled by `cameraDistance`.
   */
  const placeCamera = (): void => {
    // Raised by half the extrusion's screen rise, so the board plus the block
    // heights above it is centred in the frustum rather than the plane alone.
    target.set(0, EXTRUSION_RISE / 2, 0);
    camera.position.set(
      0,
      target.y + Math.sin(cameraTilt) * cameraDistance,
      Math.cos(cameraTilt) * cameraDistance,
    );
    camera.lookAt(target);
    camera.updateProjectionMatrix();
  };

  /**
   * Writes the frustum for the current canvas size and geometry.
   *
   * @returns Whether the projection changed.
   */
  const applyFrustum = (): boolean => {
    if (geometry === null || width <= 0 || height <= 0) {
      return false;
    }

    const half = frustumHalfExtent(geometry);
    const aspect = width / height;
    const halfWidth = aspect >= 1 ? half * aspect : half;
    const halfHeight = aspect >= 1 ? half : half / aspect;

    if (
      camera.left === -halfWidth &&
      camera.right === halfWidth &&
      camera.top === halfHeight &&
      camera.bottom === -halfHeight
    ) {
      return false;
    }

    camera.left = -halfWidth;
    camera.right = halfWidth;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;

    placeCamera();

    return true;
  };

  const applyTheme = (theme?: Theme): void => {
    const resolved = theme ?? getActiveTheme();
    const background = resolved.palette.pageBackground;

    try {
      // Alpha zero: the colour is carried for the one case a host composites the
      // canvas against it rather than against the page, and the container's own
      // background is what shows through everywhere else.
      renderer.setClearColor(toThreeColor(readThemeColor(background)), 0);
      reporter.onCount({
        name: THEME_METRIC,
        value: 1,
        detail: Object.freeze({ theme: resolved.id }),
      });
    } catch (error: unknown) {
      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message: 'A theme background could not be read; the clear colour stands.',
        detail: Object.freeze({ theme: resolved.id }),
        error: describeRenderError(error),
      });
    }
  };

  // The context-loss handler the product has never had: WebGL is a hard runtime
  // prerequisite, and a lost context is silent without this.
  const onContextLost = (event: Event): void => {
    // Cancelling the default action is what allows a restore to be attempted at
    // all; without it the context is gone for the page's lifetime.
    event.preventDefault();
    contextLost = true;

    reporter.onCount({ name: CONTEXT_LOST_METRIC, value: 1 });
    reporter.onDiagnostic({
      level: 'error',
      source: DIAGNOSTIC_SOURCE,
      message:
        'The WebGL context was lost; the board stops drawing until it is ' +
        'restored.',
    });
  };

  const onContextRestored = (): void => {
    contextLost = false;

    reporter.onDiagnostic({
      level: 'info',
      source: DIAGNOSTIC_SOURCE,
      message: 'The WebGL context was restored.',
    });
  };

  options.canvas.addEventListener('webglcontextlost', onContextLost);
  options.canvas.addEventListener('webglcontextrestored', onContextRestored);

  const releaseTheme = subscribeToThemeChange((theme): void => {
    applyTheme(theme);
  });

  applyTheme();
  placeCamera();

  reporter.onCount({
    name: CREATED_METRIC,
    value: 1,
    detail: Object.freeze({ boardSize }),
  });

  let disposed = false;

  return Object.freeze({
    renderer,
    scene,
    camera,
    boardRoot,

    resize(nextWidth: number, nextHeight: number): boolean {
      if (
        !Number.isFinite(nextWidth) ||
        !Number.isFinite(nextHeight) ||
        nextWidth <= 0 ||
        nextHeight <= 0
      ) {
        return false;
      }

      if (nextWidth === width && nextHeight === height) {
        return false;
      }

      width = nextWidth;
      height = nextHeight;

      // `false` for the third argument: the canvas's CSS size is the
      // stylesheet's business, and writing it here would fight the layout.
      renderer.setSize(width, height, false);
      applyFrustum();

      reporter.onCount({
        name: RESIZED_METRIC,
        value: 1,
        detail: Object.freeze({ width, height }),
      });

      return true;
    },

    reframe(nextSize: number, nextGeometry: GeometryScale): boolean {
      if (!isSupportedBoardSize(nextSize)) {
        reporter.onDiagnostic({
          level: 'warning',
          source: DIAGNOSTIC_SOURCE,
          message: 'A board size the product does not support was refused.',
          detail: Object.freeze({ boardSize: nextSize }),
        });

        return false;
      }

      const changed = nextSize !== boardSize || nextGeometry !== geometry;

      boardSize = nextSize;
      geometry = nextGeometry;

      applyFrustum();

      if (changed) {
        reporter.onCount({
          name: REFRAMED_METRIC,
          value: 1,
          detail: Object.freeze({ boardSize }),
        });
      }

      return changed;
    },

    render(): void {
      if (disposed || contextLost) {
        return;
      }

      renderer.render(scene, camera);
    },

    applyTheme,

    isContextLost: (): boolean => contextLost,

    dispose(): void {
      if (disposed) {
        return;
      }

      disposed = true;

      releaseTheme();
      options.canvas.removeEventListener('webglcontextlost', onContextLost);
      options.canvas.removeEventListener(
        'webglcontextrestored',
        onContextRestored,
      );

      hemisphere.dispose();
      key.dispose();
      fill.dispose();

      scene.remove(hemisphere, key, fill, boardRoot);
      renderer.dispose();

      reporter.onCount({ name: DISPOSED_METRIC, value: 1 });
    },
  });
}
