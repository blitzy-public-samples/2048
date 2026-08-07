// Contract suite for the render layer's value domain, theme lifecycle and
// resource bounds, AAP R4 and R7.
//
// Four properties are pinned here because none of them is visible to the type
// checker and each is a runtime failure rather than a compile error:
//
//   value domain     `RulesConfig.merge.produce` admits any positive integer,
//                    so a configured or relic-created tile can carry a value
//                    the colour ramp is not defined over. Every such tile has
//                    to have a material and a numeral.
//   theme lifecycle  a mesh holds the material instance it was handed. A theme
//                    change therefore has to re-dress that instance rather than
//                    dispose it, and every live mesh has to be rebound.
//   destruction      `destroy()` is terminal and `dispose()` is reusable, so
//                    nothing can be allocated after the release that released
//                    it.
//   bounds           every buffer is sized from the option parameters, so each
//                    parameter carries an explicit ceiling.
//
// A fifth property, the continuity of the cell-to-world coordinate function, is
// pinned because a move tween crosses integer cell boundaries on every move and
// a discontinuity there is a visible jump.
//
// The numeral textures need a 2D canvas context, which jsdom does not
// implement; the factory reports that and renders blocks without numerals, so
// the assertions below read the material and mesh bindings rather than the
// drawn glyphs.

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultRulesConfig } from '../../../src/config/default-config';
import {
  particleLimits,
  createParticleSystem,
  readBurstTint,
} from '../../../src/render/particles';
import { createTileMaterialCache } from '../../../src/render/tile-materials';
import {
  cellToWorld,
  createTileMeshFactory,
} from '../../../src/render/tile-mesh-factory';
import { applyTheme, getActiveTheme } from '../../../src/theme/themes';
import { rampValue, tileRampConstants } from '../../../src/theme/tile-ramp';

/** The first tile value strictly above the ramp, which is the super band. */
const FIRST_SUPER_VALUE = rampValue(tileRampConstants.limit + 1);

// The theme in force is module state, so each assertion leaves the default
// palette behind it.
afterEach(() => {
  applyTheme('default');
});

/* ===== 1. Every legal tile value is dressed (AAP R4) ===== */

describe('the material cache dresses a value the ramp does not carry', () => {
  it('resolves a material for a value that is not a power of two', () => {
    const cache = createTileMaterialCache();

    expect(() => cache.getTileMaterial(6)).not.toThrow();
    expect(cache.readStats().invalidValues).toBeGreaterThan(0);

    cache.destroy();
  });

  it('dresses it as the ramp entry at or below it, every time', () => {
    const cache = createTileMaterialCache();

    expect(cache.getNumeralColor(6)).toBe(cache.getNumeralColor(4));
    expect(cache.getTileMaterial(6)).toBe(cache.getTileMaterial(4));
    expect(cache.getTileMaterial(6)).toBe(cache.getTileMaterial(6));

    cache.destroy();
  });

  it('dresses a value above the ramp as the super band', () => {
    const cache = createTileMaterialCache();

    expect(cache.getNumeralColor(5000)).toBe(
      cache.getNumeralColor(FIRST_SUPER_VALUE),
    );

    cache.destroy();
  });

  it('dresses a value below the ramp as the ramp\'s first entry', () => {
    const cache = createTileMaterialCache();

    expect(cache.getNumeralColor(1)).toBe(
      cache.getNumeralColor(rampValue(tileRampConstants.exponentStart)),
    );

    cache.destroy();
  });

  it('hands out a block for a value off the ramp', () => {
    const materials = createTileMaterialCache();
    const factory = createTileMeshFactory({
      materials,
      config: createDefaultRulesConfig(),
    });

    factory.buildBoard(4);

    expect(() => factory.acquireTileMesh(6)).not.toThrow();

    factory.dispose();
    materials.destroy();
  });
});

/* ===== 2. A theme change re-dresses rather than disposes (AAP R7) ===== */

describe('adopting a theme keeps the live material instances', () => {
  it('re-dresses the cached material in place', () => {
    const cache = createTileMaterialCache();
    const material = cache.getTileMaterial(2048);
    const before = material.color.getHexString();

    cache.setTheme('high-contrast');

    expect(cache.getTileMaterial(2048)).toBe(material);
    expect(material.color.getHexString()).not.toBe(before);
    expect(cache.readStats().materialsDisposed).toBe(0);
    expect(cache.readStats().themeRebuilds).toBe(1);

    cache.destroy();
  });

  it('re-dresses the two board surfaces in place as well', () => {
    const cache = createTileMaterialCache();
    const field = cache.getBoardFieldMaterial();
    const cell = cache.getEmptyCellMaterial();
    const beforeField = field.color.getHexString();

    cache.setTheme('high-contrast');

    expect(cache.getBoardFieldMaterial()).toBe(field);
    expect(cache.getEmptyCellMaterial()).toBe(cell);
    expect(field.color.getHexString()).not.toBe(beforeField);

    cache.destroy();
  });

  it('rebinds every live mesh when the palette in force changes', () => {
    const materials = createTileMaterialCache();
    const factory = createTileMeshFactory({
      materials,
      config: createDefaultRulesConfig(),
    });
    const board = factory.buildBoard(4);
    const mesh = factory.acquireTileMesh(2048);
    const field = board.field.material;

    applyTheme('high-contrast');

    expect(materials.getTheme().id).toBe('high-contrast');
    expect(board.field.material).toBe(field);
    expect(board.field.material).toBe(materials.getBoardFieldMaterial());
    expect(mesh.material).toBe(materials.getTileMaterial(2048));
    expect(materials.readStats().materialsDisposed).toBe(0);
    expect(factory.readStats().numeralThemeRebuilds).toBeGreaterThan(0);

    factory.dispose();
    materials.destroy();
  });

  it('reports a refresh on a factory holding no board', () => {
    const materials = createTileMaterialCache();
    const factory = createTileMeshFactory({
      materials,
      config: createDefaultRulesConfig(),
    });

    expect(factory.refreshTheme()).toBe(false);

    factory.dispose();

    expect(factory.refreshTheme()).toBe(false);

    materials.destroy();
  });
});

/* ===== 3. destroy() is terminal, dispose() is reusable ===== */

describe('the material cache separates dispose from destroy', () => {
  it('refuses every allocating member after destroy', () => {
    const cache = createTileMaterialCache();

    cache.getTileMaterial(2);
    cache.destroy();

    expect(() => cache.getTileMaterial(2)).toThrow(/destroyed/);
    expect(() => cache.getNumeralColor(2)).toThrow(/destroyed/);
    expect(() => cache.getNumeralThreeColor(2)).toThrow(/destroyed/);
    expect(() => cache.getBoardFieldMaterial()).toThrow(/destroyed/);
    expect(() => cache.getEmptyCellMaterial()).toThrow(/destroyed/);
    expect(() => cache.setTheme('high-contrast')).toThrow(/destroyed/);
  });

  it('keeps the query members readable after destroy', () => {
    const cache = createTileMaterialCache();

    cache.destroy();

    expect(cache.getTheme().id).toBe('default');
    expect(cache.readStats().destroyed).toBe(true);
    expect(() => cache.resetStats()).not.toThrow();
    expect(() => cache.dispose()).not.toThrow();
    expect(() => cache.destroy()).not.toThrow();
  });

  it('leaves the cache usable after dispose', () => {
    const cache = createTileMaterialCache();

    cache.getTileMaterial(2);
    cache.dispose();

    expect(() => cache.getTileMaterial(2)).not.toThrow();
    expect(cache.readStats().destroyed).toBe(false);

    cache.destroy();
  });
});

/* ===== 4. The particle burst reads the palette in force (AAP R7) ===== */

describe('a burst tint follows the active palette', () => {
  it('takes the halo colour of the palette in force', () => {
    const light = readBurstTint(2048, 1);

    applyTheme('high-contrast');

    const dark = readBurstTint(2048, 1);

    expect(getActiveTheme().id).toBe('high-contrast');
    expect([dark.r, dark.g, dark.b]).not.toEqual([light.r, light.g, light.b]);
  });

  it('takes the halo of a palette named explicitly', () => {
    expect(readBurstTint(2048, 1, 'colorblind-safe')).not.toEqual(
      readBurstTint(2048, 1, 'default'),
    );
  });

  it('takes the halo alone for a value the ramp does not cover', () => {
    expect(readBurstTint(6, 0, 'default')).toEqual(
      readBurstTint(6, 1, 'default'),
    );
  });
});

/* ===== 5. Every allocation parameter carries a ceiling ===== */

describe('the particle system confines its allocation parameters', () => {
  it('confines an absurd per-burst count and burst count', () => {
    const system = createParticleSystem({
      particlesPerBurst: 1e9,
      maxConcurrentBursts: 1e9,
    });
    const stats = system.readStats();

    expect(stats.particlesPerBurst).toBeLessThanOrEqual(
      particleLimits.maxParticlesPerBurst,
    );
    expect(stats.budget).toBeLessThanOrEqual(particleLimits.maxBudget);
    expect(stats.invalidOptions).toBeGreaterThan(0);

    system.dispose();
  });

  it('keeps the budget within its ceiling at the per-burst ceiling', () => {
    const system = createParticleSystem({
      particlesPerBurst: particleLimits.maxParticlesPerBurst,
      maxConcurrentBursts: particleLimits.maxConcurrentBursts,
    });

    expect(system.readStats().budget).toBeLessThanOrEqual(
      particleLimits.maxBudget,
    );

    system.dispose();
  });

  it('lifts a mask resolution below two to the minimum', () => {
    const system = createParticleSystem({ maskResolution: 1 });

    // One texel resolves the falloff's centre to zero, so every offset divides
    // by it and the mask comes out fully transparent.
    expect(system.readStats().invalidOptions).toBeGreaterThan(0);

    system.dispose();
  });

  it('accepts the defaults without reporting a rejection', () => {
    const system = createParticleSystem();

    expect(system.readStats().invalidOptions).toBe(0);

    system.dispose();
  });
});

/* ===== 6. One continuous cell-to-world coordinate function ===== */

describe('cellToWorld is continuous across every cell boundary', () => {
  /**
   * The world x of one cell coordinate at the default board size.
   *
   * @param coordinate Zero-based coordinate, possibly fractional.
   * @returns The world x.
   */
  const worldX = (coordinate: number): number =>
    cellToWorld({ x: coordinate, y: 0 }, createDefaultRulesConfig().boardSize)
      .x;

  it('agrees with itself on both sides of an integer', () => {
    const epsilon = 1e-6;
    const tolerance = 1e-3;

    for (const cell of [1, 2, 3]) {
      expect(Math.abs(worldX(cell - epsilon) - worldX(cell))).toBeLessThan(
        tolerance,
      );
      expect(Math.abs(worldX(cell + epsilon) - worldX(cell))).toBeLessThan(
        tolerance,
      );
    }
  });

  it('rises monotonically across the whole span', () => {
    let previous = worldX(0);

    for (let tenth = 1; tenth <= 30; tenth += 1) {
      const next = worldX(tenth / 10);

      expect(next).toBeGreaterThan(previous);
      previous = next;
    }
  });

  it('lands each integer on the floored Sass step', () => {
    // The step style/main.scss L492-L493 compiles: floor((106.25 + 15) * n).
    const step = (index: number): number => Math.floor(121.25 * index);

    for (const cell of [1, 2, 3]) {
      expect(worldX(cell) - worldX(0)).toBeCloseTo(step(cell), 6);
    }
  });
});
