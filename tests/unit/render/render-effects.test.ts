// Behaviour suite for the three R7 effects: the merge particle burst, the
// camera punch and shake, and the evolving stage lighting.
//
// jsdom implements no rendering context, and none of these three needs one: a
// particle system is a `Points` over typed arrays, the camera effects write a
// `Camera`'s transform, and a scene is a graph of lights and a camera. Nothing
// below draws a frame.

import { afterEach, describe, expect, it } from 'vitest';
import { Camera, OrthographicCamera, Vector3 } from 'three';
import type { BufferAttribute } from 'three';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import {
  createCameraEffects,
  mergeIntensity,
  punchZoomFor,
} from '../../../src/render/camera-effects';
import {
  createParticleSystem,
  particleDefaults,
  particleSpreadFor,
} from '../../../src/render/particles';
import { createScene } from '../../../src/render/scene';
import { resolveBoardGeometry } from '../../../src/render/tile-mesh-factory';
import type { GeometryScale } from '../../../src/theme/tokens';
import {
  desktopGeometry,
  mobileGeometry,
} from '../../../src/theme/tokens';
import {
  queryReducedMotion,
  setReducedMotionOverride,
} from '../../../src/render/webgl-support';
import { applyTheme, getTheme } from '../../../src/theme/themes';
import type { Theme } from '../../../src/theme/themes';

/** A world point a burst is emitted at. */
const ORIGIN = Object.freeze({ x: 1.5, y: 2.5, z: -3.5 });

/** A second point, so two bursts are distinguishable by origin. */
const SECOND_ORIGIN = Object.freeze({ x: -2.5, y: 1.5, z: 0.5 });

/**
 * The delay the `pop` cadence holds a burst's first keyframe across, in ms.
 */
const POP_DELAY_MS = 100;

/** The duration the `pop` cadence runs for, in ms. */
const POP_DURATION_MS = 200;

/** A tile value the ramp resolves, so the tint is a ramp fill. */
const MERGED_VALUE = 8;

/** A camera to write, framed as the scene frames one. */
const createCamera = (): OrthographicCamera => {
  const camera = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);

  camera.position.set(0, 6, 8);
  camera.lookAt(0, 0, 0);

  return camera;
};

/** How far the camera stands from its rest position. */
const displacement = (
  camera: OrthographicCamera,
  rest: Vector3,
): number => camera.position.distanceTo(rest);

// The theme in force and the motion override are module state, so each
// assertion leaves the defaults behind it.
afterEach(() => {
  applyTheme('default');
  setReducedMotionOverride(null);
});

describe('the merge particle burst', () => {
  it('emits one burst of the stated size', () => {
    const system = createParticleSystem({ reducedMotion: false });

    expect(system.burstAt(ORIGIN, MERGED_VALUE)).toBe(true);
    expect(system.activeBurstCount()).toBe(1);
    expect(system.activeParticleCount()).toBe(
      particleDefaults.particlesPerBurst,
    );
    expect(system.isActive()).toBe(true);
    expect(system.readStats().bursts).toBe(1);

    system.dispose();
  });

  it('emits TWO bursts for a move that resolved two merges', () => {
    const system = createParticleSystem({ reducedMotion: false });

    // `tile:merge` is emitted once per merge, so a move resolving two merges
    // reaches the renderer twice and has to burst twice.
    system.burstAt(ORIGIN, MERGED_VALUE);
    system.burstAt(SECOND_ORIGIN, MERGED_VALUE * 2);

    expect(system.activeBurstCount()).toBe(2);
    expect(system.activeParticleCount()).toBe(
      particleDefaults.particlesPerBurst * 2,
    );
    expect(system.readStats().bursts).toBe(2);

    system.dispose();
  });

  it('writes mote positions into the point cloud', () => {
    const system = createParticleSystem({ reducedMotion: false });
    const positions = system.getObject().geometry.getAttribute('position');
    const before = Array.from(positions.array as Float32Array);

    system.burstAt(ORIGIN, MERGED_VALUE);

    const emitted = Array.from(positions.array as Float32Array);

    // The emission itself writes: every mote of the burst sits at the emission
    // point, which is the `pop` cadence's first keyframe under
    // `animation-fill-mode: backwards`.
    expect(emitted).not.toEqual(before);
    expect(emitted).toContain(ORIGIN.x);

    system.advance({ delta: POP_DELAY_MS + 60 });

    const advanced = Array.from(positions.array as Float32Array);

    expect(advanced).not.toEqual(emitted);

    system.dispose();
  });

  it('counts a tile value the ramp does not resolve, and bursts anyway', () => {
    const system = createParticleSystem({ reducedMotion: false });

    expect(system.burstAt(ORIGIN, 6)).toBe(true);
    expect(system.readStats().invalidValues).toBe(1);

    system.dispose();
  });

  it('refuses an origin that is not a point, without throwing', () => {
    const system = createParticleSystem({ reducedMotion: false });

    expect(
      system.burstAt({ x: Number.NaN, y: 0, z: 0 }, MERGED_VALUE),
    ).toBe(false);
    expect(system.readStats().invalidOrigins).toBe(1);
    expect(system.activeBurstCount()).toBe(0);

    system.dispose();
  });

  it('retires the oldest burst rather than refusing a new merge', () => {
    const system = createParticleSystem({
      reducedMotion: false,
      maxConcurrentBursts: 1,
    });

    expect(system.burstAt(ORIGIN, MERGED_VALUE)).toBe(true);

    // At the budget, the newest merge wins. The pool is fixed, so something
    // has to give, and the burst a player is looking at is the one that just
    // happened: the oldest is retired and its slots reused.
    expect(system.burstAt(SECOND_ORIGIN, MERGED_VALUE)).toBe(true);
    expect(system.readStats().budgetExhaustions).toBe(1);
    expect(system.activeBurstCount()).toBe(1);
    expect(system.readStats().bursts).toBe(2);

    system.dispose();
  });

  it('refuses every burst once disposed', () => {
    const system = createParticleSystem({ reducedMotion: false });

    system.dispose();

    expect(system.burstAt(ORIGIN, MERGED_VALUE)).toBe(false);
    expect(system.readStats().disposed).toBe(true);
    expect(system.isActive()).toBe(false);
  });
});

describe('advancing a burst', () => {
  it('keeps it running while its lifetime has not elapsed', () => {
    const system = createParticleSystem({ reducedMotion: false });

    system.burstAt(ORIGIN, MERGED_VALUE);
    system.advance({ delta: system.readStats().lifetimeMs / 4 });

    expect(system.isActive()).toBe(true);
    expect(system.activeBurstCount()).toBe(1);

    system.dispose();
  });

  it('RETIRES it once its lifetime is spent', () => {
    const system = createParticleSystem({ reducedMotion: false });

    system.burstAt(ORIGIN, MERGED_VALUE);
    system.advance({ delta: system.readStats().lifetimeMs + 1 });

    // A burst that never retires is a frame loop that never parks: the loop
    // stops when idle, and an effect that reports work forever keeps the page
    // rendering for the rest of the session.
    expect(system.isActive()).toBe(false);
    expect(system.activeBurstCount()).toBe(0);
    expect(system.activeParticleCount()).toBe(0);

    system.dispose();
  });

  it('frees its slot for the next merge as it retires', () => {
    const system = createParticleSystem({
      reducedMotion: false,
      maxConcurrentBursts: 1,
    });

    system.burstAt(ORIGIN, MERGED_VALUE);
    system.advance({ delta: system.readStats().lifetimeMs + 1 });

    // A retired burst leaves its slot free, so the next merge costs nothing:
    // the exhaustion count stays at zero where a burst was allowed to finish.
    expect(system.burstAt(SECOND_ORIGIN, MERGED_VALUE)).toBe(true);
    expect(system.readStats().budgetExhaustions).toBe(0);

    system.dispose();
  });

  it('treats a delta that is not a positive number as no time at all', () => {
    const system = createParticleSystem({ reducedMotion: false });

    system.burstAt(ORIGIN, MERGED_VALUE);
    system.advance({ delta: Number.NaN });

    expect(system.readStats().invalidDeltas).toBe(1);
    expect(system.isActive()).toBe(true);

    system.dispose();
  });

  it('writes nothing while no burst is running', () => {
    const system = createParticleSystem({ reducedMotion: false });
    // Typed as the union a geometry may hold; this system's own attribute is a
    // `BufferAttribute`, whose `version` is the counter `needsUpdate = true`
    // increments.
    const attribute = system.getObject().geometry.getAttribute(
      'position',
    ) as BufferAttribute;
    const before = attribute.version;

    system.advance({ delta: 16 });

    // A parked loop leaves the pool exactly as the last step left it, so an
    // idle frame uploads nothing to the GPU.
    expect(attribute.version).toBe(before);

    system.dispose();
  });
});

describe('with motion reduced', () => {
  it('emits no burst and counts the refusal', () => {
    const system = createParticleSystem({ reducedMotion: true });

    expect(system.isReducedMotion()).toBe(true);
    expect(system.burstAt(ORIGIN, MERGED_VALUE)).toBe(false);
    expect(system.activeParticleCount()).toBe(0);
    expect(system.isActive()).toBe(false);
    expect(system.readStats().suppressed).toBe(1);
    expect(system.readStats().bursts).toBe(0);

    system.dispose();
  });

  it('follows the effective preference where none was forced', () => {
    setReducedMotionOverride(true);

    const system = createParticleSystem();

    expect(queryReducedMotion()).toBe(true);
    expect(system.isReducedMotion()).toBe(true);
    expect(system.burstAt(ORIGIN, MERGED_VALUE)).toBe(false);

    setReducedMotionOverride(false);

    expect(system.isReducedMotion()).toBe(false);
    expect(system.burstAt(ORIGIN, MERGED_VALUE)).toBe(true);

    system.dispose();
  });

  it('never writes the camera', () => {
    const camera = createCamera();
    const rest = camera.position.clone();
    const restZoom = camera.zoom;
    const effects = createCameraEffects(camera, { reducedMotion: true });

    expect(effects.punch()).toBe(false);
    expect(effects.punchForMerge(2048)).toBe(false);
    expect(effects.shake()).toBe(false);

    effects.advance({ delta: 16 });

    // The camera punch and the shake are exactly the effects the AAP gates
    // behind the reduced-motion preference, and the proof is the transform —
    // the projection the punch is drawn on included.
    expect(displacement(camera, rest)).toBe(0);
    expect(camera.zoom).toBe(restZoom);
    expect(effects.readStats().zoomShare).toBe(0);
    expect(effects.isActive()).toBe(false);
    expect(effects.readStats().suppressed).toBe(3);

    effects.destroy();
  });
});

describe('the camera punch', () => {
  it('starts, widens the projection and returns it to rest', () => {
    const camera = createCamera();
    const rest = camera.position.clone();
    const restZoom = camera.zoom;
    const effects = createCameraEffects(camera, { reducedMotion: false });

    expect(effects.punch()).toBe(true);
    expect(effects.isActive()).toBe(true);
    expect(effects.readStats().punches).toBe(1);

    // Past the delay: the punch is `pop 200ms ease $transition-speed`, so its
    // first keyframe carries no impulse and holds for 100 ms.
    effects.advance({ delta: POP_DELAY_MS + 50 });

    // THE PROJECTION, not the position. This camera is orthographic, which has
    // no perspective divide, so a displacement along its view axis leaves the
    // projected image identical — the punch AAP R7 requires has to reach the
    // frustum to reach the screen at all.
    expect(camera.zoom).toBeLessThan(restZoom);
    expect(effects.readStats().zoomShare).toBeGreaterThan(0);
    expect(displacement(camera, rest)).toBe(0);

    effects.advance({ delta: 10_000 });

    expect(effects.isActive()).toBe(false);
    expect(camera.zoom).toBe(restZoom);
    expect(effects.readStats().zoomShare).toBe(0);
    expect(displacement(camera, rest)).toBe(0);

    effects.destroy();
  });

  it('widens the projection by a share a viewer can see', () => {
    const camera = createCamera();
    const restZoom = camera.zoom;
    const effects = createCameraEffects(camera, { reducedMotion: false });

    expect(effects.punch(1)).toBe(true);

    // Stepped to the overshoot the `pop` keyframes carry the peak on.
    effects.advance({ delta: POP_DELAY_MS + POP_DURATION_MS / 2 });

    const share = effects.readStats().zoomShare;

    // The board is drawn ACROSS the frustum, so the share is the fraction of
    // the board's own measure the impulse moves its edges by. A share this size
    // is two orders of magnitude above the floor a frame comparison resolves.
    expect(share).toBeGreaterThan(0.02);
    expect(camera.zoom).toBeCloseTo(restZoom / (1 + share), 10);

    effects.destroy();
  });

  it('displaces a camera whose projection carries no zoom', () => {
    // A bare camera: the fallback path, and the only path a view-axis
    // displacement is the punch on.
    const camera = new Camera();

    camera.position.set(0, 6, 8);
    camera.lookAt(0, 0, 0);

    const rest = camera.position.clone();
    const effects = createCameraEffects(camera, { reducedMotion: false });

    expect(effects.punch()).toBe(true);

    effects.advance({ delta: POP_DELAY_MS + 50 });

    expect(camera.position.distanceTo(rest)).toBeGreaterThan(0);
    expect(effects.readStats().offsetDistance).toBeGreaterThan(0);
    expect(effects.readStats().zoomShare).toBe(0);

    effects.advance({ delta: 10_000 });

    expect(camera.position.distanceTo(rest)).toBe(0);

    effects.destroy();
  });

  it('confines the composed share of several punches at once', () => {
    const camera = createCamera();
    const restZoom = camera.zoom;
    const effects = createCameraEffects(camera, {
      reducedMotion: false,
      punchZoom: 0.03,
    });

    // A move can carry one merge per row, and each merge asks for its own
    // punch, so the composed share has to be bounded.
    for (let index = 0; index < 8; index += 1) {
      expect(effects.punch(1)).toBe(true);
    }

    effects.advance({ delta: POP_DELAY_MS + POP_DURATION_MS / 2 });

    expect(effects.readStats().zoomShare).toBeLessThanOrEqual(0.06);
    expect(effects.readStats().clampedZooms).toBeGreaterThan(0);
    expect(camera.zoom).toBeGreaterThan(restZoom / 1.07);

    effects.destroy();
  });

  it('scales with the value of the merge that caused it', () => {
    const small = mergeIntensity(4);
    const large = mergeIntensity(2048);

    // A 2048 landing should not feel like a 4 landing.
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThanOrEqual(0);
    expect(large).toBeLessThanOrEqual(1);
  });

  it('punches for a merge through that scale', () => {
    const camera = createCamera();
    const effects = createCameraEffects(camera, { reducedMotion: false });

    expect(effects.punchForMerge(2048)).toBe(true);
    expect(effects.readStats().punches).toBe(1);

    effects.destroy();
  });

  it('refuses every effect once destroyed', () => {
    const camera = createCamera();
    const rest = camera.position.clone();
    const effects = createCameraEffects(camera, { reducedMotion: false });

    effects.destroy();

    expect(effects.punch()).toBe(false);
    expect(effects.shake()).toBe(false);

    effects.advance({ delta: 16 });

    expect(displacement(camera, rest)).toBe(0);
  });
});

/* ==========================================================================
 * ADDED: both geometry-derived magnitudes follow the geometry in force, not the
 * desktop constants (DL-PARTICLE-07, DL-CAMERA-05, DL-THREE-10).
 *
 * `spread` is one CELL PITCH and the punch's peak is a share of the FIELD
 * MEASURE, so both are planar lengths — which is precisely what the stylesheet's
 * mobile scale and a configured board size change. `lift`, `size`,
 * `punchDistance` and `shakeDistance` are expressions on `depthScale` and are
 * deliberately left alone: every block is extruded by the same depth at both
 * scales.
 * ========================================================================== */

describe('the geometry-derived effect magnitudes', () => {
  /** One cell pitch of a geometry, which is what a burst's spread must be. */
  const pitchOf = (geometry: GeometryScale): number =>
    geometry.tileSize + geometry.gridSpacing;

  it('measures the burst spread as one pitch of the geometry in force', () => {
    const desktop = createParticleSystem({
      reducedMotion: false,
      geometry: desktopGeometry,
    });
    const mobile = createParticleSystem({
      reducedMotion: false,
      geometry: mobileGeometry,
    });

    expect(desktop.readStats().spread).toBeCloseTo(pitchOf(desktopGeometry), 6);
    expect(desktop.readStats().spread).toBeCloseTo(particleDefaults.spread, 6);
    expect(mobile.readStats().spread).toBeCloseTo(pitchOf(mobileGeometry), 6);

    // The defect: the desktop pitch on the mobile field is about 1.8 of the
    // pitches the spray is supposed to cross.
    expect(particleDefaults.spread / pitchOf(mobileGeometry)).toBeGreaterThan(
      1.7,
    );
    expect(mobile.readStats().spreadPinned).toBe(false);

    desktop.dispose();
    mobile.dispose();
  });

  it('re-measures the spread when the renderer rebuilds its board', () => {
    const system = createParticleSystem({
      reducedMotion: false,
      geometry: desktopGeometry,
    });

    // The breakpoint crossing, which rebuilds the board at the other scale.
    expect(system.useGeometry(mobileGeometry)).toBeCloseTo(
      pitchOf(mobileGeometry),
      6,
    );
    expect(system.readStats().spread).toBeCloseTo(pitchOf(mobileGeometry), 6);

    // And a board size that changed: a 3x3 desktop board has a WIDER pitch than
    // the 4x4 the default is derived from, so a fixed spread crosses only three
    // quarters of a cell.
    const wider = resolveBoardGeometry(3, 'desktop');

    expect(system.useGeometry(wider)).toBeCloseTo(pitchOf(wider), 6);
    expect(pitchOf(wider)).toBeGreaterThan(particleDefaults.spread);

    // Idempotent: the same geometry twice re-measures nothing.
    expect(system.useGeometry(wider)).toBeCloseTo(pitchOf(wider), 6);

    system.dispose();
  });

  it('keeps a spread a caller stated, and says so', () => {
    const system = createParticleSystem({
      reducedMotion: false,
      geometry: desktopGeometry,
      spread: 42,
    });

    expect(system.readStats().spread).toBe(42);
    expect(system.readStats().spreadPinned).toBe(true);
    expect(system.useGeometry(mobileGeometry)).toBe(42);
    expect(system.readStats().spread).toBe(42);

    system.dispose();
  });

  it('measures the punch peak against the field in force', () => {
    const desktop = createCameraEffects(createCamera(), {
      reducedMotion: false,
      geometry: desktopGeometry,
    });
    const mobile = createCameraEffects(createCamera(), {
      reducedMotion: false,
      geometry: mobileGeometry,
    });
    const desktopPeak = desktop.readStats().punchZoom;
    const mobilePeak = mobile.readStats().punchZoom;

    expect(mobilePeak).toBeGreaterThan(desktopPeak);

    // The defect: the desktop share on the mobile field is 280/500 of the punch
    // that field deserves — about 44% weaker.
    expect(desktopPeak / mobilePeak).toBeCloseTo(
      mobileGeometry.fieldWidth / desktopGeometry.fieldWidth,
      6,
    );
    expect(desktop.readStats().punchZoomPinned).toBe(false);

    desktop.destroy();
    mobile.destroy();
  });

  it('re-measures the punch peak, and its ceiling, on a reframe', () => {
    const camera = createCamera();
    const restZoom = camera.zoom;
    const effects = createCameraEffects(camera, {
      reducedMotion: false,
      geometry: desktopGeometry,
    });
    const desktopPeak = effects.readStats().punchZoom;

    expect(effects.useGeometry(mobileGeometry)).toBeGreaterThan(desktopPeak);

    const mobilePeak = effects.readStats().punchZoom;

    // The re-measured peak is what the next punch is drawn with.
    expect(effects.punch(1)).toBe(true);

    effects.advance({ delta: POP_DELAY_MS + POP_DURATION_MS / 2 });

    const share = effects.readStats().zoomShare;

    expect(share).toBeGreaterThan(desktopPeak);
    expect(share).toBeLessThanOrEqual(mobilePeak);
    expect(camera.zoom).toBeCloseTo(restZoom / (1 + share), 10);

    effects.advance({ delta: 10_000 });
    effects.destroy();
  });

  it('keeps a punch zoom a caller stated, and says so', () => {
    const effects = createCameraEffects(createCamera(), {
      reducedMotion: false,
      geometry: desktopGeometry,
      punchZoom: 0.03,
    });

    expect(effects.readStats().punchZoom).toBe(0.03);
    expect(effects.readStats().punchZoomPinned).toBe(true);
    expect(effects.useGeometry(mobileGeometry)).toBe(0.03);

    effects.destroy();
  });

  it('falls back to the desktop magnitudes for an unusable geometry', () => {
    // Neither derivation may answer with a value a burst or a projection cannot
    // be drawn from, whatever a caller hands it.
    const broken = {
      ...desktopGeometry,
      tileSize: Number.NaN,
      gridSpacing: Number.NaN,
      fieldWidth: 0,
    };

    expect(particleSpreadFor(broken)).toBe(particleDefaults.spread);
    expect(punchZoomFor(broken)).toBeCloseTo(
      punchZoomFor(desktopGeometry),
      10,
    );
  });
});

describe('the camera shake', () => {
  it('starts, oscillates and decays back to rest', () => {
    const camera = createCamera();
    const rest = camera.position.clone();
    const effects = createCameraEffects(camera, { reducedMotion: false });

    expect(effects.shake(1, 300)).toBe(true);
    expect(effects.readStats().shakes).toBe(1);

    effects.advance({ delta: POP_DELAY_MS + 60 });

    const early = displacement(camera, rest);

    expect(early).toBeGreaterThan(0);

    effects.advance({ delta: 301 });

    expect(effects.isActive()).toBe(false);
    expect(displacement(camera, rest)).toBe(0);

    effects.destroy();
  });

  it('displaces DETERMINISTICALLY from its own elapsed time', () => {
    const readShakeOffsets = (): number[] => {
      const camera = createCamera();
      const rest = camera.position.clone();
      const effects = createCameraEffects(camera, { reducedMotion: false });
      const offsets: number[] = [];

      effects.shake(1, 400);

      for (let step = 0; step < 6; step += 1) {
        effects.advance({ delta: 50 });
        offsets.push(displacement(camera, rest));
      }

      effects.destroy();

      return offsets;
    };

    // No randomness: the shake is a function of its own elapsed time, which is
    // what keeps a recorded run reproducible and keeps the run PRNG out of a
    // cosmetic effect.
    expect(readShakeOffsets()).toEqual(readShakeOffsets());
  });

  it('confines an intensity outside the unit span and reports it', () => {
    const camera = createCamera();
    const effects = createCameraEffects(camera, { reducedMotion: false });

    effects.shake(50, 200);

    expect(effects.readStats().clampedIntensities).toBeGreaterThan(0);

    effects.destroy();
  });

  it('is cleared, with the camera put back, by reset', () => {
    const camera = createCamera();
    const rest = camera.position.clone();
    const effects = createCameraEffects(camera, { reducedMotion: false });

    effects.shake(1, 1000);
    effects.advance({ delta: POP_DELAY_MS + 50 });

    expect(displacement(camera, rest)).toBeGreaterThan(0);

    effects.reset();

    expect(effects.isActive()).toBe(false);
    expect(displacement(camera, rest)).toBe(0);

    effects.destroy();
  });

  it('writes nothing while no effect is running', () => {
    const camera = createCamera();
    const rest = camera.position.clone();
    const effects = createCameraEffects(camera, { reducedMotion: false });

    effects.advance({ delta: 16 });

    expect(displacement(camera, rest)).toBe(0);
    expect(effects.readStats().offsetDistance).toBe(0);

    effects.destroy();
  });
});

describe('the stage lighting', () => {
  it('re-tunes the rig for a later stage', () => {
    const scene = createScene({ config: createDefaultRulesConfig() });
    const first = scene.readTuning();

    expect(scene.applyStageTheme(4)).toBe(true);

    const later = scene.readTuning();

    // The evolving lighting theme R7 names: a run that reaches stage five is
    // lit differently from its opening stage, and the tuning is the value that
    // says so.
    expect(later.stageIndex).toBe(4);
    expect(later.progress).toBeGreaterThan(first.progress);
    expect(later).not.toEqual(first);
    expect(scene.readStats().retunes).toBeGreaterThan(0);

    scene.dispose();
  });

  it('advances monotonically through a run without ever reaching one', () => {
    const scene = createScene();
    const progress: number[] = [];

    for (let stage = 0; stage < 8; stage += 1) {
      scene.applyStageTheme(stage);
      progress.push(scene.readTuning().progress);
    }

    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]).toBeGreaterThan(progress[index - 1] ?? -1);
    }

    // Never one: the curve extends past the ladder, so a run that keeps going
    // must not saturate the lighting and stop evolving.
    expect(Math.max(...progress)).toBeLessThan(1);

    scene.dispose();
  });

  it('shifts the key light as the stage advances', () => {
    const scene = createScene();
    const opening = scene.lights.key.color.getHex();
    const openingIntensity = scene.lights.key.intensity;

    scene.applyStageTheme(7);

    // The rig itself is re-tuned, not merely a number in a report: the same
    // two light instances are re-dressed, so nothing has to be rebuilt
    // mid-run.
    expect(scene.lights.count).toBe(2);
    expect(
      scene.lights.key.color.getHex() !== opening ||
        scene.lights.key.intensity !== openingIntensity,
    ).toBe(true);

    scene.dispose();
  });

  it('reports no change for the stage already in force', () => {
    const scene = createScene();

    scene.applyStageTheme(3);

    expect(scene.applyStageTheme(3)).toBe(false);

    scene.dispose();
  });

  it('confines a negative stage index to the first stage', () => {
    const scene = createScene();

    scene.applyStageTheme(5);
    scene.applyStageTheme(-2);

    expect(scene.readTuning().stageIndex).toBe(0);

    scene.dispose();
  });

  it('refuses a stage index that is not a finite number', () => {
    const scene = createScene();
    const before = scene.readTuning();

    expect(scene.applyStageTheme(Number.NaN)).toBe(false);
    expect(scene.readTuning()).toEqual(before);
    expect(scene.readStats().refused).toBeGreaterThan(0);

    scene.dispose();
  });

  it('takes the light white point from the palette, not from a literal', () => {
    const scene = createScene({ theme: getTheme('default') });

    expect(scene.lights.ambient.color.getHexString()).toBe('ffffff');
    expect(getTheme('default').palette.neutralLight).toBe('#ffffff');

    // A palette stating its own white point reaches the rig through the same
    // guarded reader every other palette entry is read through.
    const warmed: Theme = {
      ...getTheme('default'),
      palette: { ...getTheme('default').palette, neutralLight: '#ff0000' },
    };

    scene.applyTheme(warmed);

    expect(scene.lights.ambient.color.getHexString()).toBe('ff0000');

    scene.applyTheme({
      ...warmed,
      id: 'default',
      palette: { ...warmed.palette, neutralLight: 'not-a-colour' },
    });

    expect(scene.lights.ambient.color.getHexString()).toBe('ffffff');

    scene.dispose();
  });

  it('re-tunes against a palette change', () => {
    const scene = createScene();
    const before = scene.readTuning();

    scene.applyTheme(getTheme('colorblind-safe'));

    const after = scene.readTuning();

    // The additive palettes state their own halo, and the key light is mixed
    // toward it, so a palette switched mid-run has to reach the rig.
    expect(after.themeId).toBe('colorblind-safe');
    expect(after.themeId).not.toBe(before.themeId);

    scene.dispose();
  });

  it('follows the theme in force where none was pinned', () => {
    const scene = createScene();

    applyTheme('high-contrast');

    // Built with no theme, so it subscribes: the settings surface changes the
    // palette and the lighting follows without the scene being rebuilt.
    expect(scene.readTuning().themeId).toBe('high-contrast');

    scene.dispose();
  });

  it('holds a pinned theme against a change in force', () => {
    const scene = createScene({ theme: getTheme('default') });

    applyTheme('high-contrast');

    // An explicit theme pins the rig, which is what lets a test or a capture
    // hold one palette while the page changes.
    expect(scene.readTuning().themeId).toBe('default');

    scene.dispose();
  });

  it('re-frames for a board a cursed relic shrank', () => {
    const scene = createScene({ boardSize: 4 });
    const before = scene.readFraming();

    expect(scene.reframe(3)).toBe(true);

    const after = scene.readFraming();

    // A board-shrinking relic changes the edge length mid-run, and the camera
    // has to follow it or the board is drawn off-centre.
    expect(after.halfExtent).not.toBe(before.halfExtent);
    expect(scene.readStats().boardSize).toBe(3);
    expect(scene.readStats().reframes).toBeGreaterThan(0);

    scene.dispose();
  });
});
