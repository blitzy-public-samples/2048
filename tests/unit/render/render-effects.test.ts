// Behaviour suite for the three R7 effects: the merge particle burst, the
// camera punch and shake, and the evolving stage lighting.
//
// WHY THIS SUITE EXISTS
//   All three modules shipped complete, and every assertion the suite carried
//   was about their CONSTRUCTION: buffer ceilings, option confinement and tint
//   derivation. Nothing called `burstAt`, nothing advanced a burst, nothing
//   built the camera effects at all and nothing re-tuned a stage — so "the board
//   bursts on a merge", "the camera punches", "a burst ends" and "the lighting
//   evolves through a run" were untested claims about the three features R7
//   names by name.
//
// WHAT IS PINNED HERE
//   EMISSION      a burst is emitted, is the size it says it is, and two merges
//                 in one move produce two bursts rather than one.
//   ADVANCEMENT   a burst moves and fades while it runs, and RETIRES when its
//                 lifetime is spent, so a parked loop is left with nothing
//                 outstanding.
//   SUPPRESSION   with motion reduced, no mote is emitted and the camera is
//                 never written — the highest-leverage accessibility measure the
//                 AAP names, and the one that has to be provable.
//   DETERMINISM   a shake is a function of its own elapsed time, so the same
//                 shake advanced the same way displaces identically.
//   THE STAGE     `applyStageTheme` re-tunes the rig, the tuning advances with
//                 the stage, and a palette change re-tunes it against the
//                 palette in force.
//
// jsdom implements no rendering context, and none of these three needs one: a
// particle system is a `Points` over typed arrays, the camera effects write a
// `Camera`'s transform, and a scene is a graph of lights and a camera. Nothing
// below draws a frame.

import { afterEach, describe, expect, it } from 'vitest';
import { OrthographicCamera, Vector3 } from 'three';
import type { BufferAttribute } from 'three';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import {
  createCameraEffects,
  mergeIntensity,
} from '../../../src/render/camera-effects';
import {
  createParticleSystem,
  particleDefaults,
} from '../../../src/render/particles';
import { createScene } from '../../../src/render/scene';
import {
  queryReducedMotion,
  setReducedMotionOverride,
} from '../../../src/render/webgl-support';
import { applyTheme, getTheme } from '../../../src/theme/themes';

/**
 * A world point a burst is emitted at.
 *
 * Off the world origin deliberately: the first keyframe places every mote AT the
 * emission point and holds it there for the `pop` delay, so a burst emitted at
 * (0, 0, 0) writes zeros into a buffer that already held zeros and an assertion
 * on "the positions changed" could not tell an emission from a no-op.
 */
const ORIGIN = Object.freeze({ x: 1.5, y: 2.5, z: -3.5 });

/** A second point, so two bursts are distinguishable by origin. */
const SECOND_ORIGIN = Object.freeze({ x: -2.5, y: 1.5, z: 0.5 });

/** The delay the `pop` cadence holds a burst's first keyframe across, in ms. */
const POP_DELAY_MS = 100;

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

/* ==========================================================================
 * 1. The merge burst is emitted
 * ========================================================================== */

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
    // reaches the renderer twice and has to burst twice. One burst for a
    // two-merge move would under-report the move a player just made.
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

    // Past the delay, the motes have travelled: they are no longer all at the
    // point they were emitted from.
    system.advance({ delta: POP_DELAY_MS + 60 });

    const advanced = Array.from(positions.array as Float32Array);

    expect(advanced).not.toEqual(emitted);

    system.dispose();
  });

  it('counts a tile value the ramp does not resolve, and bursts anyway', () => {
    const system = createParticleSystem({ reducedMotion: false });

    // A merge relic can produce a value off the powers of two the ramp is
    // defined over, and the burst is cosmetic: it takes the halo colour rather
    // than refusing to fire.
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

    // AT THE BUDGET, THE NEWEST MERGE WINS. The pool is fixed, so something has
    // to give, and the burst a player is looking at is the one that just
    // happened: the oldest is retired and its slots reused. Refusing instead
    // would drop the visible merge and keep an expiring one.
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

/* ==========================================================================
 * 2. A burst advances and retires
 * ========================================================================== */

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

    // A retired burst leaves its slot free, so the next merge costs nothing: the
    // exhaustion count stays at zero where a burst was allowed to finish.
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
    // increments. `needsUpdate` itself is write-only, so the upload request is
    // observed through the version rather than by reading the flag back.
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

/* ==========================================================================
 * 3. Motion reduced: nothing is emitted and nothing is written
 * ========================================================================== */

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

    // Read live rather than captured at construction, so an explicit override
    // and an operating-system setting both take effect without a reload.
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
    const effects = createCameraEffects(camera, { reducedMotion: true });

    expect(effects.punch()).toBe(false);
    expect(effects.punchForMerge(2048)).toBe(false);
    expect(effects.shake()).toBe(false);

    effects.advance({ delta: 16 });

    // The camera punch and the shake are exactly the effects the AAP gates
    // behind the reduced-motion preference, and the proof is the transform.
    expect(displacement(camera, rest)).toBe(0);
    expect(effects.isActive()).toBe(false);
    expect(effects.readStats().suppressed).toBe(3);

    effects.destroy();
  });
});

/* ==========================================================================
 * 4. The camera punch
 * ========================================================================== */

describe('the camera punch', () => {
  it('starts, displaces the camera and returns it to rest', () => {
    const camera = createCamera();
    const rest = camera.position.clone();
    const effects = createCameraEffects(camera, { reducedMotion: false });

    expect(effects.punch()).toBe(true);
    expect(effects.isActive()).toBe(true);
    expect(effects.readStats().punches).toBe(1);

    // Past the delay: the punch is `pop 200ms ease $transition-speed`, so its
    // first keyframe carries no displacement and holds for 100 ms. Advancing 16
    // ms would read the held keyframe and see the camera at rest, which is
    // correct rather than broken.
    effects.advance({ delta: POP_DELAY_MS + 50 });

    expect(displacement(camera, rest)).toBeGreaterThan(0);
    expect(effects.readStats().offsetDistance).toBeGreaterThan(0);

    // Long enough to outrun any punch: the effect ends and the camera is put
    // back rather than left leaning.
    effects.advance({ delta: 10_000 });

    expect(effects.isActive()).toBe(false);
    expect(displacement(camera, rest)).toBe(0);

    effects.destroy();
  });

  it('scales with the value of the merge that caused it', () => {
    const small = mergeIntensity(4);
    const large = mergeIntensity(2048);

    // A 2048 landing should not feel like a 4 landing. The scale is monotonic
    // and bounded, so the biggest merge in the game is emphatic and not
    // nauseating.
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
 * 5. The camera shake
 * ========================================================================== */

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

/* ==========================================================================
 * 6. The evolving stage lighting
 * ========================================================================== */

describe('the stage lighting', () => {
  it('re-tunes the rig for a later stage', () => {
    const scene = createScene({ config: createDefaultRulesConfig() });
    const first = scene.readTuning();

    expect(scene.applyStageTheme(4)).toBe(true);

    const later = scene.readTuning();

    // The evolving lighting theme R7 names: a run that reaches stage five is lit
    // differently from its opening stage, and the tuning is the value that says
    // so.
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

    // The rig itself is re-tuned, not merely a number in a report: the same two
    // light instances are re-dressed, so nothing has to be rebuilt mid-run.
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
