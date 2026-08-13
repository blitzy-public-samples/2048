// The scene graph, the camera and the lighting rig of the 2.5D board.
//
// WHERE THIS SUBSYSTEM IS PLACED: Figures 1 and 2 of
// docs/architecture/ARCHITECTURE.md are the two states it moved between, and
// Figure 3 of docs/architecture/component-interaction.md places this module among
// its peers. Both documents are delivered and are the present authorities.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-SCENE-01  style/main.scss L171-L194  `@mixin game-field`, reproduced as
//                                           the board surface
//   TR-SCENE-02  style/main.scss L254       the `.grid-container` layer, which
//                                           the scene replaces
//   TR-SCENE-03  style/main.scss L288       the `.tile-container` layer, which
//                                           the scene replaces
//   TR-SCENE-04  style/main.scss L475-L548  the mobile scale, framed through
//                                           this code with no branch
//   TR-SCENE-05  target-only row            `createScene()` and `BoardScene`
//   TR-SCENE-06  target-only row            `frameBoard()`, `BoardFraming` and
//                                           `CameraRestPose`
//   TR-SCENE-07  target-only row            `LightingRig` and `RigTuning`
//   TR-SCENE-08  target-only row            `sceneOptics`
//   TR-SCENE-09  target-only row            `SceneStats` and the injected
//                                           reporter
//
// Decisions: DL-SCENE-01, DL-SCENE-02, DL-SCENE-03, DL-SCENE-04, DL-SCENE-05
// (docs/DECISION_LOG.md).

import {
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  OrthographicCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Vector3,
} from 'three';
import type { Object3D } from 'three';

import type { RulesConfig } from '../config/rules-config';
import { getActiveTheme, subscribeToThemeChange } from '../theme/themes';
import type { Theme } from '../theme/themes';
import {
  depthScale,
  fieldWidth,
  gameContainerBackground,
  gridRowCells,
  gridSpacing,
  neutralLightColor,
  tileGoldGlowColor,
} from '../theme/tokens';
import type { GeometryScale, ScaleName } from '../theme/tokens';
import {
  boardLayers,
  cellToWorldIn,
  resolveBoardGeometry,
} from './tile-mesh-factory';
import type { RenderDetail, RenderReporter } from './webgl-support';
import {
  NOOP_RENDER_REPORTER,
  createGuardedRenderReporter,
  describeRenderError,
} from './webgl-support';

/** Value every diagnostic raised here carries as its `source`. */
const DIAGNOSTIC_SOURCE = 'render/scene';

/** Counter raised once per scene created. */
const CREATED_METRIC = 'render.scene.created';

/** Counter raised once per light the rig installed. */
const LIGHT_METRIC = 'render.scene.light';

/** Counter raised once per board group mounted. */
const MOUNTED_METRIC = 'render.scene.mounted';

/** Counter raised once per re-frame that changed the framing. */
const REFRAMED_METRIC = 'render.scene.reframed';

/** Counter raised once per resize that changed the frustum. */
const RESIZED_METRIC = 'render.scene.resized';

/** Counter raised once per theme the rig re-tuned against. */
const THEME_METRIC = 'render.scene.theme';

/** Counter raised once per stage the rig re-tuned for. */
const STAGE_METRIC = 'render.scene.stage';

/** Counter raised once per argument refused. */
const REFUSED_METRIC = 'render.scene.refused';

/** Counter raised once per disposal. */
const DISPOSED_METRIC = 'render.scene.disposed';

/** Parents `wouldCycle` walks before giving up. */
const MAX_ANCESTOR_WALK = 64;

/**
 * Widest aspect ratio a viewport may resolve to, and the reciprocal of the
 * narrowest.
 */
const MAX_VIEWPORT_ASPECT = 32_768;

/** Largest frustum half-extent a projection may carry, in world units. */
const MAX_FRUSTUM_EXTENT = Number.MAX_SAFE_INTEGER;

/** Diffuse irradiance the rig delivers to a surface facing the viewer. */
const TOTAL_IRRADIANCE = Math.PI;

/**
 * The camera and lighting magnitudes, each an expression on the geometry and
 * depth tokens of src/theme/tokens.ts, whose `depthScale` states that camera
 * and lighting values are declared under src/render.
 *
 * Angles are in radians, lengths in board-space px — one board-space px is one
 * CSS px — and the four shares are fractions of `TOTAL_IRRADIANCE`.
 */
export const sceneOptics = Object.freeze({
  /** Tilt of the camera off the board's normal. */
  tilt: Math.atan2(gridSpacing - depthScale.bevel, depthScale.tile),

  /** Clearance held between the drawn board and the frustum edge. */
  margin: depthScale.bevel,

  /** Distance from the camera's target to the camera. */
  distance: fieldWidth,

  /** Half-depth of the orthographic frustum, either side of `distance`. */
  depthSpan: fieldWidth / 2,

  /**
   * Share of `TOTAL_IRRADIANCE` the key light carries at stage zero.
   *
   * The key reaches the sides and the bevels alone, and the hemisphere fill
   * already floors a side at the mean of its two colours, so the share is held
   * where the brightest bevel stays under a surface facing the viewer.
   */
  keyShareBase: depthScale.bevel / depthScale.board,

  /** Share the key light gains across a run. */
  keyShareRange: depthScale.bevel / depthScale.tile,

  /** Weight the key light's colour reaches toward the palette's halo. */
  warmRange: depthScale.bevel / depthScale.tile,

  /** Stage index at which the run's progression reaches its half point. */
  stageHalfLife: gridRowCells,
});

/** Reciprocal of the tilt's cosine, applied to the board group's y axis. */
const BOARD_Y_SCALE = 1 / Math.cos(sceneOptics.tilt);

/** Sine of the tilt, the factor by which extrusion rises up the screen. */
const TILT_SINE = Math.sin(sceneOptics.tilt);

/** Cosine of the tilt, the factor the camera's target is divided through. */
const TILT_COSINE = Math.cos(sceneOptics.tilt);

/** The z coordinate the frustum's vertical axis is anchored at. */
const DEPTH_ANCHOR = boardLayers.fieldSurface;

/** A point in board space, as a framing reports one. */
export interface FramePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * The camera transform one board size and geometry resolve to.
 *
 * Every member is derived from `sceneOptics`, the geometry of
 * src/theme/tokens.ts and the board size; none is stated.
 */
export interface BoardFraming {
  /** Cells per row the framing was computed for. */
  readonly boardSize: number;

  /** Lengths the framing was computed against. */
  readonly geometry: GeometryScale;

  /**
   * Half-extent of the square frustum, in board-space px. `resize` widens one
   * axis of it by the canvas's aspect ratio.
   */
  readonly halfExtent: number;

  /** Width of the drawn board on the frustum's horizontal axis. */
  readonly spanX: number;

  /** Height of the drawn board on the frustum's vertical axis. */
  readonly spanY: number;

  /** Clearance held between the drawn board and the frustum edge. */
  readonly margin: number;

  /** Point the camera looks at. */
  readonly target: FramePoint;

  /** Point the camera sits at. */
  readonly position: FramePoint;

  /** Tilt of the camera off the board's normal, in radians. */
  readonly tilt: number;

  /** Distance from the target to the camera. */
  readonly distance: number;

  /** Near plane of the orthographic frustum. */
  readonly near: number;

  /** Far plane of the orthographic frustum. */
  readonly far: number;

  /** Scale applied to the board group's y axis. */
  readonly boardScaleY: number;
}

/**
 * The camera's transform with no camera effect applied, as copies a caller may
 * keep and mutate.
 */
export interface CameraRestPose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

/** The two lights the board is lit by. */
export interface LightingRig {
  readonly ambient: HemisphereLight;
  readonly key: DirectionalLight;

  /** Lights the rig installed. */
  readonly count: number;
}

/** The tuning one stage index and palette resolve to. */
export interface RigTuning {
  /** Stage index the tuning was computed for. */
  readonly stageIndex: number;

  /** The run's progression, a fraction from zero up to but never one. */
  readonly progress: number;

  /** Share of the total irradiance the key light carries. */
  readonly keyShare: number;

  /** Weight the key light's colour was mixed toward the palette's halo at. */
  readonly warmWeight: number;

  /** Id of the theme the tuning was resolved against. */
  readonly themeId: string;
}

/** What one scene has done and where it stands. */
export interface SceneStats {
  readonly boardSize: number;
  readonly halfExtent: number;
  readonly lights: number;

  /** Objects mounted into the board group. */
  readonly mountedObjects: number;
  readonly reframes: number;
  readonly resizes: number;
  readonly retunes: number;

  /** Arguments refused, across every member. */
  readonly refused: number;
  readonly stageIndex: number;
  readonly themeId: string;
  readonly disposed: boolean;
}

/** Options `frameBoard` resolves its geometry through. All are optional. */
export interface FrameBoardOptions {
  /**
   * Lengths to frame against. Defaults to the lengths `resolveBoardGeometry`
   * of src/render/tile-mesh-factory.ts resolves for the board size at `scale`,
   * which is the same call the mesh factory lays the board out through.
   */
  readonly geometry?: GeometryScale;

  /** Which of the stylesheet's two scales to resolve. Defaults to desktop. */
  readonly scale?: ScaleName;
}

/** Construction options. Every member is optional. */
export interface SceneOptions {
  /**
   * Cells per row to frame for. Defaults to `config.boardSize`, and to
   * `gridRowCells` of src/theme/tokens.ts where no configuration is supplied.
   */
  readonly boardSize?: number;

  /**
   * Rules the board size is read from. Read once, at construction: the
   * configured size is reconciled during a run, and `reframe` is the call that
   * carries a change into the camera.
   */
  readonly config?: RulesConfig;

  /** Lengths to frame against. Resolved from the board size when absent. */
  readonly geometry?: GeometryScale;

  /** Which of the stylesheet's two scales to resolve. Defaults to desktop. */
  readonly scale?: ScaleName;

  /** Stage index to tune the rig for. Defaults to the first stage. */
  readonly stageIndex?: number;

  /**
   * Theme to tune the rig against. Omitted, the theme in force is read at
   * construction and the rig follows every later change.
   */
  readonly theme?: Theme;

  /**
   * Whether to follow theme changes. Defaults to `true` where no `theme` was
   * supplied and to `false` where one was, so an explicit theme pins the rig.
   */
  readonly followActiveTheme?: boolean;

  /** Sink every counter and every failure reports through. */
  readonly reporter?: RenderReporter;
}

/**
 * The scene, the camera, the lights and the board group, and the calls that
 * drive them.
 */
export interface BoardScene {
  /** The scene graph root. Carries the board group and the two lights. */
  readonly scene: Scene;

  /** The camera the board is projected through. */
  readonly camera: OrthographicCamera;

  /**
   * The group the mesh factory's output is mounted into, centred on the
   * board's middle so a camera effect or a rotation acts about the board's
   * centre rather than about its corner.
   */
  readonly boardGroup: Group;

  /** The lights installed in the scene. */
  readonly lights: LightingRig;

  /**
   * Parents one object to the board group.
   *
   * @param object The mesh factory's board group.
   * @returns Whether the object was mounted.
   */
  mountBoard(object: Object3D): boolean;

  /**
   * Detaches every object mounted into the board group.
   *
   * Nothing the mesh factory owns is disposed: the geometries, the materials
   * and the numeral textures belong to that factory, and this call releases
   * the graph edges alone.
   *
   * @returns How many objects were detached.
   */
  clearBoard(): number;

  /**
   * Sizes the frustum to a canvas's CSS pixel size, holding the framing fitted
   * at either orientation.
   *
   * @param width CSS width, in px.
   * @param height CSS height, in px.
   * @returns Whether the size was adopted. `false` where it is the size
   *   already held, where either length is not a positive finite number, and
   *   where the RATIO between them resolves to no usable frustum — two finite
   *   lengths can still overflow or underflow the aspect, and a refusal on
   *   that ground leaves the held size and the camera exactly as they were.
   */
  resize(width: number, height: number): boolean;

  /**
   * Re-frames the camera for a board size, and re-reads the rest transform.
   *
   * Called when a board-mutating relic changes the edge length and when the
   * scale changes at the mobile breakpoint of style/main.scss L475.
   *
   * @param boardSize Cells per row.
   * @param geometry Lengths resolved for that size and scale. Resolved from
   *   the board size when absent.
   * @returns Whether the framing changed.
   */
  reframe(boardSize: number, geometry?: GeometryScale): boolean;

  /** The framing in force. */
  readFraming(): BoardFraming;

  /** The camera's transform with no camera effect applied. */
  readRestTransform(): CameraRestPose;

  /**
   * Re-tunes the rig for a stage index.
   *
   * @param stageIndex Zero-based stage index. A negative index is confined
   *   to zero and reported; a non-finite one is refused.
   * @returns Whether the tuning changed.
   */
  applyStageTheme(stageIndex: number): boolean;

  /**
   * Re-tunes the rig against a theme.
   *
   * @param theme Theme to tune against. Defaults to the theme in force.
   */
  applyTheme(theme?: Theme): void;

  /** The tuning in force. */
  readTuning(): RigTuning;

  /** What this scene has done and where it stands. */
  readStats(): SceneStats;

  /**
   * Releases the lights, the board group and the theme subscription.
   *
   * Idempotent. Three.js frees nothing on collection, so this is the call a
   * teardown makes.
   */
  dispose(): void;
}

/** The unit channel value. */
const UNIT_CHANNEL = /* @__PURE__ */ new Color();

/** Rejects an argument that is not a finite number. */
function assertFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `scene: ${name} must be a finite number, received ${String(value)}`,
    );
  }
}

/** Rejects a board size that is not a positive integer. */
function assertBoardSize(value: number): void {
  assertFiniteNumber('boardSize', value);
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(
      `scene: boardSize must be a positive integer, received ${String(value)}`,
    );
  }
}

/** Confines a fraction to zero through one. */
function confineFraction(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** Displacement up the frustum's vertical axis that one depth resolves to. */
function depthRise(z: number): number {
  return (z - DEPTH_ANCHOR) * TILT_SINE;
}

/** The drawn board's bounds on the frustum's two axes. */
interface BoardBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Bounds of the board as the mesh factory lays it out at one size. */
function readBoardBounds(
  boardSize: number,
  geometry: GeometryScale,
): BoardBounds {
  const lastIndex = boardSize - 1;
  const first = cellToWorldIn({ x: 0, y: 0 }, geometry);
  const last = cellToWorldIn({ x: lastIndex, y: lastIndex }, geometry);
  const halfCell = geometry.tileSize / 2;

  return {
    minX: Math.min(first.x, last.x) - halfCell,
    maxX: Math.max(first.x, last.x) + halfCell,
    minY:
      Math.min(first.y, last.y) -
      halfCell +
      depthRise(boardLayers.tileBase),
    maxY:
      Math.max(first.y, last.y) +
      halfCell +
      depthRise(boardLayers.tileSurface),
  };
}

/**
 * The camera transform one board size resolves to.
 *
 * @param boardSize Cells per row.
 * @param options Geometry to frame against, or the scale to resolve it at.
 * @returns The framing, frozen.
 * @throws RangeError when `boardSize` is not a positive integer, or when it
 *   is beyond the largest size src/render/tile-mesh-factory.ts resolves
 *   lengths for.
 * @example
 * ```ts
 * const framing = frameBoard(4);
 * const mobile = frameBoard(4, { scale: 'mobile' });
 * ```
 */
export function frameBoard(
  boardSize: number,
  options: FrameBoardOptions = {},
): BoardFraming {
  assertBoardSize(boardSize);

  const geometry =
    options.geometry ?? resolveBoardGeometry(boardSize, options.scale);
  const bounds = readBoardBounds(boardSize, geometry);
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const centreX = (bounds.minX + bounds.maxX) / 2;
  const centreY = (bounds.minY + bounds.maxY) / 2;
  const halfExtent = Math.max(spanX, spanY) / 2 + sceneOptics.margin;

  // The board group's y axis is pre-scaled by `BOARD_Y_SCALE`, so a drawn
  // point sits at `y * BOARD_Y_SCALE` in world space and the target's own y is
  // the fitted centre divided back through the tilt's cosine.
  const target: FramePoint = {
    x: centreX,
    y: centreY / TILT_COSINE,
    z: DEPTH_ANCHOR,
  };

  return Object.freeze({
    boardSize,
    geometry,
    halfExtent,
    spanX,
    spanY,
    margin: sceneOptics.margin,
    target: Object.freeze(target),
    position: Object.freeze({
      x: target.x,
      y: target.y - sceneOptics.distance * TILT_SINE,
      z: target.z + sceneOptics.distance * TILT_COSINE,
    }),
    tilt: sceneOptics.tilt,
    distance: sceneOptics.distance,
    near: sceneOptics.distance - sceneOptics.depthSpan,
    far: sceneOptics.distance + sceneOptics.depthSpan,
    boardScaleY: BOARD_Y_SCALE,
  });
}

/** Whether a value carries Three.js's object marker. */
function isObject3D(value: unknown): value is Object3D {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly isObject3D?: unknown }).isObject3D === true
  );
}

/** The two half-extents one viewport resolves the orthographic frustum to. */
interface FrustumProjection {
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * Reports whether `candidate` is `descendant` itself or an ancestor of it.
 *
 * @param candidate Object being mounted.
 * @param descendant Group it would be mounted into.
 * @returns `true` where mounting would create a cycle.
 */
function wouldCycle(candidate: Object3D, descendant: Object3D): boolean {
  let walked: Object3D | null = descendant;

  for (let step = 0; step < MAX_ANCESTOR_WALK && walked !== null; step += 1) {
    if (walked === candidate) {
      return true;
    }

    walked = walked.parent;
  }

  return false;
}

/** The tuning one stage index and theme resolve to. */
function computeTuning(stageIndex: number, theme: Theme): RigTuning {
  const denominator = stageIndex + sceneOptics.stageHalfLife;
  const progress =
    denominator > 0 ? confineFraction(stageIndex / denominator) : 0;

  return Object.freeze({
    stageIndex,
    progress,
    keyShare: confineFraction(
      sceneOptics.keyShareBase + sceneOptics.keyShareRange * progress,
    ),
    warmWeight: confineFraction(sceneOptics.warmRange * progress),
    themeId: theme.id,
  });
}

/**
 * Reads one palette entry into a colour, holding a fallback where it cannot be
 * read.
 *
 * @param target Colour written into and returned.
 * @param value Palette entry to read.
 * @param fallback Token to hold where the entry cannot be read.
 * @returns `target`.
 */
function readPaletteColor(
  target: Color,
  value: string,
  fallback: string,
): Color {
  target.setStyle(fallback, SRGBColorSpace);

  if (typeof value !== 'string' || value.length === 0) {
    return target;
  }

  target.setStyle(value, SRGBColorSpace);

  return target;
}

/**
 * Builds the scene graph, the camera, the board group and the lighting rig.
 *
 * The camera is framed at construction, so a caller that never calls `resize`
 * — a document with no layout engine reports no canvas size — still projects a
 * fitted board.
 *
 * @param options Board size, geometry, stage, theme and report sink.
 * @returns A frozen scene.
 * @example
 * ```ts
 * const board = createScene({ boardSize: 4 });
 * board.mountBoard(factory.buildBoard(4).group);
 * board.resize(470, 470);
 * ```
 */
export function createScene(options: SceneOptions = {}): BoardScene {
  const reporter = createGuardedRenderReporter(
    options.reporter ?? NOOP_RENDER_REPORTER,
  );

  let refused = 0;

  /** Reports one refused or confined argument. */
  const reportRefused = (
    message: string,
    detail: RenderDetail,
    level: 'warning' | 'error' = 'warning',
  ): void => {
    refused += 1;
    reporter.onCount({ name: REFUSED_METRIC, value: 1, detail });
    reporter.onDiagnostic({
      level,
      source: DIAGNOSTIC_SOURCE,
      message,
      detail,
    });
  };

  const scene = new Scene();

  // TRANSPARENT. The canvas is composited over `.game-container`, whose
  // `$game-container-background` at style/main.scss L188 is the colour the
  // board field itself is drawn in, and the DOM overlay layer at
  // style/main.scss L205 composites above the canvas.
  scene.background = null;

  const boardGroup = new Group();

  boardGroup.name = 'board-root';

  // The tilt's vertical foreshortening, cancelled on the way in.
  boardGroup.scale.set(1, BOARD_Y_SCALE, 1);
  scene.add(boardGroup);

  const ambient = new HemisphereLight();
  const key = new DirectionalLight();

  ambient.name = 'board-ambient';
  key.name = 'board-key';

  // Directions, not places: a hemisphere light's axis and a directional
  // light's direction are both read off the light's own position, and a
  // directional light's default target sits at the origin.
  ambient.position.set(0, 0, fieldWidth);

  // Along the board plane, with no depth component at all: the key reaches the
  // sides and the bevel ring of a block and contributes nothing to a surface
  // facing the viewer, whose normal it meets at a right angle.
  key.position.set(-gridSpacing * fieldWidth, gridSpacing * fieldWidth, 0);

  const rigLights = [ambient, key] as const;

  scene.add(...rigLights);

  const lights: LightingRig = Object.freeze({
    ambient,
    key,
    count: rigLights.length,
  });

  const camera = new OrthographicCamera();
  const cameraTarget = new Vector3();
  const restPosition = new Vector3();
  const restQuaternion = new Quaternion();
  const keyColor = new Color();
  const haloColor = new Color();

  // The palette's own white point, re-read on every tuning so a palette change
  // reaches the lights with the same latency every other palette entry does.
  const neutralColor = new Color().copy(UNIT_CHANNEL);

  /**
   * The framing the scene opens with.
   *
   * The board size is read from `boardSize`, then from the `RulesConfig`'s
   * own, then from `gridRowCells` of src/theme/tokens.ts. A size the renderer
   * cannot frame is reported and the token's size framed instead, so
   * construction always yields a projecting camera.
   */
  const resolveInitialFraming = (): BoardFraming => {
    const requested =
      options.boardSize ?? options.config?.boardSize ?? gridRowCells;

    try {
      return frameBoard(requested, {
        geometry: options.geometry,
        scale: options.scale,
      });
    } catch (error: unknown) {
      refused += 1;
      reporter.onCount({
        name: REFUSED_METRIC,
        value: 1,
        detail: Object.freeze({ boardSize: String(requested) }),
      });
      reporter.onDiagnostic({
        level: 'warning',
        source: DIAGNOSTIC_SOURCE,
        message:
          'A board size the renderer cannot frame was refused; the ' +
          'stylesheet\u2019s own board size was framed instead.',
        detail: Object.freeze({
          boardSize: String(requested),
          framed: gridRowCells,
        }),
        error: describeRenderError(error),
        thrown: error,
      });

      return frameBoard(gridRowCells, { scale: options.scale });
    }
  };

  let disposed = false;
  let framing = resolveInitialFraming();
  let viewportWidth = 0;
  let viewportHeight = 0;
  let stageIndex = 0;
  let theme: Theme = options.theme ?? getActiveTheme();
  let tuning: RigTuning = computeTuning(stageIndex, theme);
  let reframes = 0;
  let resizes = 0;
  let retunes = 0;
  let mountedObjects = 0;

  /** Writes the camera's transform from the framing in force. */
  const placeCamera = (): void => {
    cameraTarget.set(
      framing.target.x,
      framing.target.y,
      framing.target.z,
    );
    camera.position.set(
      framing.position.x,
      framing.position.y,
      framing.position.z,
    );
    camera.lookAt(cameraTarget);
    camera.near = framing.near;
    camera.far = framing.far;
    camera.updateProjectionMatrix();

    restPosition.copy(camera.position);
    restQuaternion.copy(camera.quaternion);
  };

  /**
   * The frustum one viewport resolves to, or `null` where it resolves to none.
   *
   * @param width Candidate viewport width.
   * @param height Candidate viewport height.
   * @returns The half-extents, or `null` for a viewport that resolves to a
   *   non-finite, non-positive or out-of-range plane.
   */
  const projectionFor = (
    width: number,
    height: number,
  ): FrustumProjection | null => {
    const aspect = width > 0 && height > 0 ? width / height : 1;

    // Measured BEFORE either plane is derived from it, so an aspect that
    // overflowed or underflowed cannot reach the arithmetic below.
    if (
      !Number.isFinite(aspect) ||
      aspect <= 0 ||
      aspect > MAX_VIEWPORT_ASPECT ||
      aspect < 1 / MAX_VIEWPORT_ASPECT
    ) {
      return null;
    }

    const half = framing.halfExtent;
    const halfWidth = aspect >= 1 ? half * aspect : half;
    const halfHeight = aspect >= 1 ? half : half / aspect;

    // Each DERIVED value is measured too: a finite aspect inside the band
    // still has to produce planes a projection matrix can carry.
    if (
      !Number.isFinite(halfWidth) ||
      !Number.isFinite(halfHeight) ||
      halfWidth <= 0 ||
      halfHeight <= 0 ||
      halfWidth > MAX_FRUSTUM_EXTENT ||
      halfHeight > MAX_FRUSTUM_EXTENT
    ) {
      return null;
    }

    return { halfWidth, halfHeight };
  };

  /**
   * Writes the frustum for the framing in force and the viewport last seen.
   *
   * The square half-extent is inscribed in whichever axis is shorter, so the
   * board stays fitted at a portrait aspect ratio and at a landscape one
   * alike.
   *
   * @returns Whether the projection changed.
   */
  const applyFrustum = (): boolean => {
    const projection = projectionFor(viewportWidth, viewportHeight);

    if (projection === null) {
      return false;
    }

    const { halfWidth, halfHeight } = projection;

    if (
      camera.left === -halfWidth &&
      camera.right === halfWidth &&
      camera.top === halfHeight &&
      camera.bottom === -halfHeight &&
      camera.near === framing.near &&
      camera.far === framing.far
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

  /**
   * Re-tunes the two lights for the stage index and palette in force.
   *
   * @returns Whether the tuning changed.
   */
  const retune = (): boolean => {
    const next = computeTuning(stageIndex, theme);

    readPaletteColor(haloColor, theme.palette.tileGlow, tileGoldGlowColor);
    readPaletteColor(
      neutralColor,
      theme.palette.neutralLight,
      neutralLightColor,
    );
    keyColor.copy(neutralColor).lerp(haloColor, next.warmWeight);

    ambient.color.copy(neutralColor);
    readPaletteColor(
      ambient.groundColor,
      theme.palette.boardField,
      gameContainerBackground,
    );
    ambient.intensity = TOTAL_IRRADIANCE;

    key.color.copy(keyColor);
    key.intensity = next.keyShare * TOTAL_IRRADIANCE;

    const changed =
      tuning.stageIndex !== next.stageIndex ||
      tuning.keyShare !== next.keyShare ||
      tuning.warmWeight !== next.warmWeight ||
      tuning.themeId !== next.themeId;

    tuning = next;
    retunes += 1;

    return changed;
  };

  const applyTheme = (next?: Theme): void => {
    if (disposed) {
      reportRefused(
        'A theme was refused: the scene has been disposed.',
        Object.freeze({ theme: next?.id ?? null }),
      );

      return;
    }

    theme = next ?? getActiveTheme();
    retune();

    reporter.onCount({
      name: THEME_METRIC,
      value: 1,
      detail: Object.freeze({
        theme: theme.id,
        keyShare: tuning.keyShare,
        warmWeight: tuning.warmWeight,
      }),
    });
  };

  const applyStageTheme = (nextStage: number): boolean => {
    if (disposed) {
      reportRefused(
        'A stage theme was refused: the scene has been disposed.',
        Object.freeze({ stageIndex: nextStage }),
      );

      return false;
    }

    if (!Number.isFinite(nextStage)) {
      reportRefused(
        'A stage index that is not a finite number was refused; the rig ' +
          'stands as it was tuned.',
        Object.freeze({ stageIndex: String(nextStage) }),
      );

      return false;
    }

    // A stage index below the first is confined to it and reported, so the rig
    // the first stage resolves to is the one adopted.
    const confined = Math.max(0, nextStage);

    if (confined !== nextStage) {
      reportRefused(
        'A negative stage index was confined to the first stage.',
        Object.freeze({ stageIndex: nextStage, confined }),
      );
    }

    if (confined === stageIndex) {
      return false;
    }

    stageIndex = confined;

    const changed = retune();

    reporter.onCount({
      name: STAGE_METRIC,
      value: 1,
      detail: Object.freeze({
        stageIndex,
        progress: tuning.progress,
        keyShare: tuning.keyShare,
      }),
    });

    return changed;
  };

  const releaseTheme =
    (options.followActiveTheme ?? options.theme === undefined)
      ? subscribeToThemeChange((next: Theme): void => {
          applyTheme(next);
        })
      : (): void => undefined;

  retune();

  if (options.stageIndex !== undefined) {
    applyStageTheme(options.stageIndex);
  }

  applyFrustum();
  placeCamera();

  reporter.onCount({
    name: LIGHT_METRIC,
    value: lights.count,
    detail: Object.freeze({
      ambient: ambient.intensity,
      key: key.intensity,
    }),
  });
  reporter.onCount({
    name: CREATED_METRIC,
    value: 1,
    detail: Object.freeze({
      boardSize: framing.boardSize,
      halfExtent: framing.halfExtent,
      tilt: framing.tilt,
      theme: theme.id,
      lights: lights.count,
    }),
  });

  return Object.freeze({
    scene,
    camera,
    boardGroup,
    lights,

    mountBoard(object: Object3D): boolean {
      if (disposed) {
        reportRefused(
          'A board was refused: the scene has been disposed.',
          Object.freeze({ boardSize: framing.boardSize }),
        );

        return false;
      }

      if (!isObject3D(object)) {
        reportRefused(
          'A board that is not a mountable object was refused; the board ' +
            'group stands as it was.',
          Object.freeze({ boardSize: framing.boardSize }),
        );

        return false;
      }

      // The board group itself and every ancestor of it are refused.
      if (wouldCycle(object, boardGroup)) {
        reportRefused(
          'A board that is the board group or an ancestor of it was refused; ' +
            'mounting it would make the scene graph cyclic.',
          Object.freeze({
            boardSize: framing.boardSize,
            objects: mountedObjects,
          }),
          'error',
        );

        return false;
      }

      try {
        boardGroup.add(object);
      } catch (error: unknown) {
        refused += 1;
        reporter.onCount({
          name: REFUSED_METRIC,
          value: 1,
          detail: Object.freeze({ boardSize: framing.boardSize }),
        });
        reporter.onDiagnostic({
          level: 'error',
          source: DIAGNOSTIC_SOURCE,
          message:
            'A board the scene graph refused to parent was refused; the ' +
            'board group stands as it was.',
          detail: Object.freeze({ boardSize: framing.boardSize }),
          error: describeRenderError(error),
          thrown: error,
        });

        return false;
      }

      mountedObjects = boardGroup.children.length;

      reporter.onCount({
        name: MOUNTED_METRIC,
        value: 1,
        detail: Object.freeze({
          boardSize: framing.boardSize,
          objects: mountedObjects,
        }),
      });

      return true;
    },

    clearBoard(): number {
      const detached = boardGroup.children.length;

      boardGroup.clear();
      mountedObjects = boardGroup.children.length;

      return detached;
    },

    resize(width: number, height: number): boolean {
      if (disposed) {
        reportRefused(
          'A canvas size was refused: the scene has been disposed.',
          Object.freeze({ width: String(width), height: String(height) }),
        );

        return false;
      }

      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
      ) {
        reportRefused(
          'A canvas size that is not two positive lengths was refused; the ' +
            'frustum stands as it was.',
          Object.freeze({ width: String(width), height: String(height) }),
        );

        return false;
      }

      if (width === viewportWidth && height === viewportHeight) {
        return false;
      }

      // The derived values are measured before anything is written.
      if (projectionFor(width, height) === null) {
        reportRefused(
          'A canvas size whose aspect ratio resolves to no usable frustum ' +
            'was refused; the frustum stands as it was.',
          Object.freeze({ width: String(width), height: String(height) }),
        );

        return false;
      }

      viewportWidth = width;
      viewportHeight = height;

      resizes += 1;

      const reprojected = applyFrustum();

      reporter.onCount({
        name: RESIZED_METRIC,
        value: 1,
        detail: Object.freeze({
          width,
          height,
          halfExtent: framing.halfExtent,
          reprojected,
        }),
      });

      return true;
    },

    reframe(nextSize: number, geometry?: GeometryScale): boolean {
      if (disposed) {
        reportRefused(
          'A re-frame was refused: the scene has been disposed.',
          Object.freeze({ boardSize: nextSize }),
        );

        return false;
      }

      let next: BoardFraming;

      try {
        next = frameBoard(nextSize, {
          geometry: geometry ?? options.geometry,
          scale: options.scale,
        });
      } catch (error: unknown) {
        refused += 1;
        reporter.onCount({
          name: REFUSED_METRIC,
          value: 1,
          detail: Object.freeze({ boardSize: String(nextSize) }),
        });
        reporter.onDiagnostic({
          level: 'warning',
          source: DIAGNOSTIC_SOURCE,
          message:
            'A board size the renderer cannot frame was refused; the camera ' +
            'stands as it was framed.',
          detail: Object.freeze({ boardSize: String(nextSize) }),
          error: describeRenderError(error),
          thrown: error,
        });

        return false;
      }

      const changed =
        next.boardSize !== framing.boardSize ||
        next.halfExtent !== framing.halfExtent ||
        next.spanX !== framing.spanX ||
        next.spanY !== framing.spanY ||
        next.target.x !== framing.target.x ||
        next.target.y !== framing.target.y;

      framing = next;
      applyFrustum();

      // Written unconditionally: `applyFrustum` places the camera only where
      // the projection changed, and a caller that re-framed is entitled to a
      // rest transform that matches the framing it asked for.
      placeCamera();

      if (changed) {
        reframes += 1;
        reporter.onCount({
          name: REFRAMED_METRIC,
          value: 1,
          detail: Object.freeze({
            boardSize: framing.boardSize,
            halfExtent: framing.halfExtent,
          }),
        });
      }

      return changed;
    },

    readFraming: (): BoardFraming => framing,

    readRestTransform: (): CameraRestPose =>
      Object.freeze({
        position: restPosition.clone(),
        quaternion: restQuaternion.clone(),
      }),

    applyStageTheme,
    applyTheme,

    readTuning: (): RigTuning => tuning,

    readStats: (): SceneStats =>
      Object.freeze({
        boardSize: framing.boardSize,
        halfExtent: framing.halfExtent,
        lights: lights.count,
        mountedObjects,
        reframes,
        resizes,
        retunes,
        refused,
        stageIndex,
        themeId: theme.id,
        disposed,
      }),

    dispose(): void {
      if (disposed) {
        return;
      }

      disposed = true;

      releaseTheme();
      boardGroup.clear();
      mountedObjects = 0;
      scene.remove(boardGroup, ...rigLights);

      for (const light of rigLights) {
        light.dispose();
      }

      reporter.onCount({
        name: DISPOSED_METRIC,
        value: 1,
        detail: Object.freeze({ boardSize: framing.boardSize }),
      });
    },
  });
}
