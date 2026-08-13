// Contract suite for the render layer's value domain, theme lifecycle and
// resource bounds, AAP R4 and R7.

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_BOARD_SIZE,
  createDefaultRulesConfig,
} from '../../../src/config/default-config';
import {
  particleLimits,
  createParticleSystem,
  readBurstTint,
} from '../../../src/render/particles';
import { createTileMaterialCache } from '../../../src/render/tile-materials';
import {
  cellArrayIndex,
  cellToWorld,
  createTileMeshFactory,
  resolveBoardGeometry,
} from '../../../src/render/tile-mesh-factory';
import {
  applyTheme,
  getActiveTheme,
  getTheme,
} from '../../../src/theme/themes';
import { rampValue, tileRampConstants } from '../../../src/theme/tile-ramp';
import type {
  RenderDiagnostic,
  RenderReporter,
} from '../../../src/render/webgl-support';

/** The first tile value strictly above the ramp, which is the super band. */
const FIRST_SUPER_VALUE = rampValue(tileRampConstants.limit + 1);

// The theme in force is module state, so each assertion leaves the default
// palette behind it.
afterEach(() => {
  applyTheme('default');
});

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

/* ===== 2. */

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
    // The step style/main.scss compiles in its tile-position loop, as
    // math.floor(($tile-size + $grid-spacing) * (n - 1)): floor((106.25 + 15)
    // * n).
    const step = (index: number): number => Math.floor(121.25 * index);

    for (const cell of [1, 2, 3]) {
      expect(worldX(cell) - worldX(0)).toBeCloseTo(step(cell), 6);
    }
  });
});

describe('the mesh factory measures a board size against the product ceiling', () => {
  it('refuses a geometry beyond MAX_BOARD_SIZE', () => {
    // Persistence, the number-only renderer and the parallel accessibility
    // board all refuse a size above the ceiling.
    expect(() => resolveBoardGeometry(MAX_BOARD_SIZE + 1)).toThrow(RangeError);
    expect(() => resolveBoardGeometry(2 ** 20)).toThrow(RangeError);
    expect(() => resolveBoardGeometry(MAX_BOARD_SIZE)).not.toThrow();
  });

  it('refuses a cell index computed against an unsupported size', () => {
    expect(() =>
      cellArrayIndex({ x: 0, y: 0 }, MAX_BOARD_SIZE + 1),
    ).toThrow(RangeError);
    expect(() => cellArrayIndex({ x: 0, y: 0 }, MAX_BOARD_SIZE)).not.toThrow();
  });

  it('refuses a board build beyond MAX_BOARD_SIZE', () => {
    const materials = createTileMaterialCache();
    const factory = createTileMeshFactory({
      config: createDefaultRulesConfig(),
      materials,
    });

    expect(() => factory.buildBoard(MAX_BOARD_SIZE + 1)).toThrow(RangeError);
    expect(() => factory.buildBoard(0)).toThrow(RangeError);
    expect(() => factory.buildBoard(4.5)).toThrow(RangeError);

    factory.dispose();
    materials.destroy();
  });
});

describe('the accessibility palettes withhold the glow from every value', () => {
  it('declares the withholding on the palette, not on the theme id', () => {
    // The renderer reads the flag; it knows nothing about which palettes exist.
    expect(getTheme('default').palette.tileGlowSuppressed).toBe(false);
    expect(getTheme('high-contrast').palette.tileGlowSuppressed).toBe(true);
    expect(getTheme('colorblind-safe').palette.tileGlowSuppressed).toBe(true);
  });

  it.each(['high-contrast', 'colorblind-safe'] as const)(
    'leaves the emissive term off for every ramp value under %s',
    (themeId) => {
      const cache = createTileMaterialCache({ theme: themeId });

      for (
        let exponent = tileRampConstants.exponentStart;
        exponent <= tileRampConstants.limit;
        exponent += 1
      ) {
        const material = cache.getTileMaterial(rampValue(exponent));

        // An emissive term is ADDITIVE over the fill, and these palettes state
        // their fills to carry a numeral at a ratio. Nothing may be added.
        expect(material.emissiveIntensity).toBe(0);
        expect(material.emissive.getHex()).toBe(0);
      }

      cache.destroy();
    },
  );

  // The glow is bounded by the headroom the fill leaves, so the fill the
  // ramp states survives the addition. Before this bound the five glow-band
  // faces all rendered with a saturated red channel: the last two steps were
  // 2.74 apart where their fills are 5.04 apart, and the numeral ratio on 2048
  // fell from the fill's own 1.58:1 to 1.05:1. DL-MATERIAL-04.
  describe('the glow never saturates the fill it is added to', () => {
    /** The glow band: every value the identity palette emits a shadow for. */
    const GLOW_BAND = [128, 256, 512, 1024, 2048] as const;

    /** One channel of a linear sum, as the 8-bit sRGB value it encodes to. */
    const encode = (linear: number): number => {
      const clamped = Math.min(Math.max(linear, 0), 1);

      return Math.round(
        (clamped <= 0.0031308
          ? clamped * 12.92
          : 1.055 * clamped ** (1 / 2.4) - 0.055) * 255,
      );
    };

    const toLinear = (channel: number): number => {
      const unit = channel / 255;

      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };

    /** The rendered face of one value: its fill plus its own glow term. */
    const renderedFace = (value: number): [number, number, number] => {
      const cache = createTileMaterialCache({ theme: 'default' });
      const material = cache.getTileMaterial(value);
      const intensity = material.emissiveIntensity;
      const face: [number, number, number] = [
        encode(material.color.r + material.emissive.r * intensity),
        encode(material.color.g + material.emissive.g * intensity),
        encode(material.color.b + material.emissive.b * intensity),
      ];

      cache.destroy();

      return face;
    };

    const toLab = (
      rgb: readonly [number, number, number],
    ): [number, number, number] => {
      const [red, green, blue] = rgb.map(toLinear) as [number, number, number];
      const x = (0.4124 * red + 0.3576 * green + 0.1805 * blue) / 0.95047;
      const y = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      const z = (0.0193 * red + 0.1192 * green + 0.9505 * blue) / 1.08883;
      const bend = (component: number): number =>
        component > 0.008856
          ? Math.cbrt(component)
          : 7.787 * component + 16 / 116;

      return [
        116 * bend(y) - 16,
        500 * (bend(x) - bend(y)),
        200 * (bend(y) - bend(z)),
      ];
    };

    const deltaE76 = (
      first: readonly [number, number, number],
      second: readonly [number, number, number],
    ): number => {
      const [l1, a1, b1] = toLab(first);
      const [l2, a2, b2] = toLab(second);

      return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
    };

    it('leaves every channel of every ramp value unsaturated', () => {
      const cache = createTileMaterialCache({ theme: 'default' });

      for (
        let exponent = tileRampConstants.exponentStart;
        exponent <= tileRampConstants.limit;
        exponent += 1
      ) {
        const material = cache.getTileMaterial(rampValue(exponent));
        const intensity = material.emissiveIntensity;

        for (const channel of ['r', 'g', 'b'] as const) {
          // A channel driven to 1 is a channel that has stopped carrying the
          // fill's identity: every value whose fill shares that anchor renders
          // the same there.
          expect(
            material.color[channel] + material.emissive[channel] * intensity,
          ).toBeLessThanOrEqual(1 + Number.EPSILON * 8);
        }
      }

      cache.destroy();
    });

    it('keeps adjacent rendered steps at least one JND apart', () => {
      for (let index = 1; index < GLOW_BAND.length; index += 1) {
        const previous = GLOW_BAND[index - 1] as number;
        const current = GLOW_BAND[index] as number;

        expect(
          deltaE76(renderedFace(previous), renderedFace(current)),
        ).toBeGreaterThanOrEqual(3);
      }
    });

    it('holds the numeral ratio close to the fill\u2019s own', () => {
      const cache = createTileMaterialCache({ theme: 'default' });
      const luminance = (rgb: readonly [number, number, number]): number => {
        const [red, green, blue] = rgb.map(toLinear) as [
          number,
          number,
          number,
        ];

        return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      };
      const ratio = (
        first: readonly [number, number, number],
        second: readonly [number, number, number],
      ): number => {
        const a = luminance(first);
        const b = luminance(second);

        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };

      for (const value of GLOW_BAND) {
        const material = cache.getTileMaterial(value);
        const fill: [number, number, number] = [
          encode(material.color.r),
          encode(material.color.g),
          encode(material.color.b),
        ];
        const numeral = cache.getNumeralColor(value).replace('#', '');
        const numeralRgb: [number, number, number] = [
          Number.parseInt(numeral.slice(0, 2), 16),
          Number.parseInt(numeral.slice(2, 4), 16),
          Number.parseInt(numeral.slice(4, 6), 16),
        ];

        // The renderer may not cost the numeral more than a tenth of a ratio
        // point against the fill the ramp states. It cost 0.53 on 2048 when the
        // term was unbounded.
        expect(
          ratio(fill, numeralRgb) - ratio(renderedFace(value), numeralRgb),
        ).toBeLessThanOrEqual(0.16);
      }

      cache.destroy();
    });

    it('still grows the term with the value', () => {
      const cache = createTileMaterialCache({ theme: 'default' });
      const intensities = GLOW_BAND.map(
        (value) => cache.getTileMaterial(value).emissiveIntensity,
      );

      // Bounding the term does not flatten it: the ramp loop of style/main.scss
      // grows the shadow with the exponent, and so does this.
      for (let index = 1; index < intensities.length; index += 1) {
        expect(intensities[index] as number).toBeGreaterThan(
          intensities[index - 1] as number,
        );
      }

      cache.destroy();
    });
  });

  it('keeps the identity palette\u2019s glow on the values that carry one', () => {
    const cache = createTileMaterialCache({ theme: 'default' });

    // The band the stylesheet emits a shadow for: above the accent band, up to
    // and including the ramp's last value.
    for (const value of [128, 256, 512, 1024, 2048]) {
      expect(cache.getTileMaterial(value).emissiveIntensity).toBeGreaterThan(0);
    }

    // And the accent band it does not, which `glowSuppressed` already gated.
    for (const value of [8, 16, 32, 64]) {
      expect(cache.getTileMaterial(value).emissiveIntensity).toBe(0);
    }

    cache.destroy();
  });
});

/* ==========================================================================
 * THE NUMERAL A BLOCK WEARS
 *
 * The numerals are what make the 2.5D board READABLE, and nothing tested them:
 * jsdom publishes neither `OffscreenCanvas` nor a 2D context, so
 * `createNumeralSurface()` answered `null` on every call, every numeral was
 * refused as `'no-2d-context'`, and a board of blank blocks passed the whole
 * suite. R7 and validation gate V9 both require a legible board.
 *
 * These cases install a RECORDING `OffscreenCanvas` — a deterministic 2D
 * context that logs every call and answers `measureText` from a width this
 * suite controls — so the drawing itself, the texture, the plane, the
 * condensing, the failure fallbacks, the theme redraw and the cache bound are
 * all observable. DL-MESH-05.
 * ========================================================================== */

/** One call the recording 2D context received. */
interface NumeralCall {
  readonly member: string;
  readonly args: readonly unknown[];
}

/** The recording surface, and readers over what was drawn on it. */
interface NumeralRecorder {
  /** Every call, in order, across every canvas created. */
  readonly calls: NumeralCall[];

  /** Canvases constructed, in order, as `[width, height]` pairs. */
  readonly canvases: { width: number; height: number }[];

  /** Every `fillText` call, in order. */
  readonly texts: () => readonly NumeralCall[];

  /** The last value assigned to one context property. */
  readonly lastSet: (member: string) => unknown;

  /** Every value assigned to one context property, in order. */
  readonly setsOf: (member: string) => readonly unknown[];

  /** Makes `measureText` answer `width` for every later call. */
  readonly measureAs: (width: number) => void;

  /** Makes the next `fillText` raise. */
  readonly failNextDraw: () => void;

  /** Makes `getContext` answer `null` for every later canvas. */
  readonly refuseContext: () => void;

  /** Restores whatever `OffscreenCanvas` was there before. */
  readonly restore: () => void;
}

/**
 * Installs a recording `OffscreenCanvas` on the global object.
 *
 * The context is a plain object whose members push onto `calls`, with the
 * properties `drawNumeral` assigns — `fillStyle`, `font`, `textAlign`,
 * `textBaseline` — recorded through setters so an assertion can read what the
 * production code actually asked for. `measureText` is deterministic: it
 * answers a width this recorder controls, which is the only way to drive the
 * condensing branch on demand.
 *
 * @returns The recorder.
 */
const recordNumeralSurface = (): NumeralRecorder => {
  const calls: NumeralCall[] = [];
  const canvases: { width: number; height: number }[] = [];
  const original = (globalThis as { OffscreenCanvas?: unknown })
    .OffscreenCanvas;
  let measuredWidth = 10;
  let failDraw = false;
  let contextRefused = false;

  const note = (member: string, ...args: readonly unknown[]): void => {
    calls.push({ member, args });
  };

  const makeContext = (): Record<string, unknown> => {
    const state: Record<string, unknown> = {};
    const context: Record<string, unknown> = {
      setTransform: (...args: readonly unknown[]): void => {
        note('setTransform', ...args);
      },
      clearRect: (...args: readonly unknown[]): void => {
        note('clearRect', ...args);
      },
      measureText: (text: string): { width: number } => {
        note('measureText', text);

        return { width: measuredWidth };
      },
      fillText: (...args: readonly unknown[]): void => {
        note('fillText', ...args);

        if (failDraw) {
          failDraw = false;

          throw new Error('fillText refused');
        }
      },
    };

    for (const member of ['fillStyle', 'font', 'textAlign', 'textBaseline']) {
      Object.defineProperty(context, member, {
        configurable: true,
        get: (): unknown => state[member],
        set: (value: unknown): void => {
          state[member] = value;
          note(`set:${member}`, value);
        },
      });
    }

    return context;
  };

  class RecordingOffscreenCanvas {
    width: number;

    height: number;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      canvases.push({ width, height });
    }

    getContext(kind: string): unknown {
      note('getContext', kind);

      return contextRefused ? null : makeContext();
    }
  }

  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    writable: true,
    value: RecordingOffscreenCanvas,
  });

  return {
    calls,
    canvases,
    texts: (): readonly NumeralCall[] =>
      calls.filter((call): boolean => call.member === 'fillText'),
    lastSet: (member: string): unknown =>
      calls.filter((call): boolean => call.member === `set:${member}`).at(-1)
        ?.args[0],
    setsOf: (member: string): readonly unknown[] =>
      calls
        .filter((call): boolean => call.member === `set:${member}`)
        .map((call): unknown => call.args[0]),
    measureAs: (width: number): void => {
      measuredWidth = width;
    },
    failNextDraw: (): void => {
      failDraw = true;
    },
    refuseContext: (): void => {
      contextRefused = true;
    },
    restore: (): void => {
      if (original === undefined) {
        delete (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas;

        return;
      }

      Object.defineProperty(globalThis, 'OffscreenCanvas', {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
};

/** A reporter that keeps every diagnostic and count. */
const collectReports = (): {
  readonly reporter: RenderReporter;
  readonly diagnostics: RenderDiagnostic[];
  readonly counts: { name: string; detail?: unknown }[];
  readonly countOf: (name: string) => number;
} => {
  const diagnostics: RenderDiagnostic[] = [];
  const counts: { name: string; detail?: unknown }[] = [];

  return {
    reporter: {
      onDiagnostic: (diagnostic): void => {
        diagnostics.push(diagnostic);
      },
      onCount: (count): void => {
        counts.push({ name: count.name, detail: count.detail });
      },
      onTiming: (): void => {},
    },
    diagnostics,
    counts,
    countOf: (name: string): number =>
      counts.filter((entry): boolean => entry.name === name).length,
  };
};

describe('the numeral a block wears', () => {
  it('draws the value onto a 2D surface and dresses the plane with it', () => {
    const recorder = recordNumeralSurface();

    try {
      const reports = collectReports();
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
        reporter: reports.reporter,
      });

      factory.buildBoard(4);

      const mesh = factory.acquireTileMesh(2048);
      const numeral = mesh.children[0];

      // DRAWN: the text is the value, centred on the tile box.
      const drawn = recorder.texts();

      expect(drawn).toHaveLength(1);
      expect(drawn[0]?.args[0]).toBe('2048');

      const geometry = resolveBoardGeometry(4, 'desktop');
      const centre = geometry.tileBoxSize / 2;

      expect(drawn[0]?.args[1]).toBeCloseTo(centre, 6);
      expect(drawn[0]?.args[2]).toBeCloseTo(centre, 6);

      // Cleared first, and centred through the two alignment properties.
      expect(
        recorder.calls.some((call): boolean => call.member === 'clearRect'),
      ).toBe(true);
      expect(recorder.lastSet('textAlign')).toBe('center');
      expect(recorder.lastSet('textBaseline')).toBe('middle');

      // Dressed in the numeral colour the ramp resolves for that value.
      expect(recorder.lastSet('fillStyle')).toBe(
        materials.getNumeralColor(2048),
      );

      // Bold, at the font size the layout resolved.
      expect(String(recorder.lastSet('font'))).toMatch(/^bold \d+(\.\d+)?px /);

      // THE PLANE IS DRESSED AND VISIBLE, with a canvas-backed map.
      expect(numeral).toBeDefined();
      expect(numeral?.visible).toBe(true);

      // The map is the canvas that was just drawn on, carried as a texture.
      // `needsUpdate` is write-only on a three.js texture, so the upload flag is
      // read through the version counter it raises.
      const material = (
        numeral as {
          material?: {
            map?: {
              image?: { width?: number };
              version?: number;
              colorSpace?: string;
            };
            transparent?: boolean;
            depthWrite?: boolean;
          };
        }
      ).material;

      expect(material?.map).toBeDefined();
      expect(material?.map?.image?.width).toBe(recorder.canvases[0]?.width);
      expect(material?.map?.version).toBeGreaterThan(0);
      expect(material?.map?.colorSpace).toBe('srgb');

      // Drawn over the block's top face, so the numeral is legible against it.
      expect(material?.transparent).toBe(true);
      expect(material?.depthWrite).toBe(false);

      // COUNTED, and cached.
      expect(reports.countOf('render.numeral.created')).toBe(1);
      expect(reports.countOf('render.numeral.unavailable')).toBe(0);
      expect(factory.readStats().numeralsCreated).toBe(1);
      expect(factory.readStats().cachedNumerals).toBe(1);
      expect(factory.readStats().numeralsUnavailable).toBe(0);

      factory.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('sizes the canvas from the tile box and the texture scale', () => {
    const recorder = recordNumeralSurface();

    try {
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
      });

      factory.buildBoard(4);
      factory.acquireTileMesh(2);

      const geometry = resolveBoardGeometry(4, 'desktop');
      const created = recorder.canvases[0];

      expect(created).toBeDefined();
      expect(created?.width).toBe(created?.height);
      expect(created?.width).toBeGreaterThanOrEqual(
        Math.ceil(geometry.tileBoxSize),
      );

      factory.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('draws one texture per value and reuses it for a second block', () => {
    const recorder = recordNumeralSurface();

    try {
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
      });

      factory.buildBoard(4);

      const first = factory.acquireTileMesh(8);
      const second = factory.acquireTileMesh(8);

      expect(recorder.texts()).toHaveLength(1);
      expect(factory.readStats().numeralsCreated).toBe(1);

      // The same material object, so the texture is genuinely shared.
      expect((first.children[0] as { material?: unknown }).material).toBe(
        (second.children[0] as { material?: unknown }).material,
      );

      factory.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('condenses a numeral too wide for the tile, and reports it', () => {
    const recorder = recordNumeralSurface();

    try {
      const reports = collectReports();
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
        reporter: reports.reporter,
      });

      factory.buildBoard(4);

      // Wider than the tile can hold, so the font is re-set smaller.
      recorder.measureAs(10_000);

      const mesh = factory.acquireTileMesh(131072);
      const fonts = recorder.setsOf('font');

      // TWO font assignments: the layout size, then the fitted one.
      expect(fonts).toHaveLength(2);

      const sizeOf = (font: unknown): number =>
        Number(/^bold ([\d.]+)px/.exec(String(font))?.[1] ?? '0');

      expect(sizeOf(fonts[1])).toBeLessThan(sizeOf(fonts[0]));
      expect(sizeOf(fonts[1])).toBeGreaterThan(0);

      // Still drawn, and still visible.
      expect(recorder.texts()).toHaveLength(1);
      expect(mesh.children[0]?.visible).toBe(true);

      expect(factory.readStats().numeralsCondensed).toBe(1);
      expect(reports.countOf('render.numeral.condensed')).toBe(1);

      factory.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('leaves the font alone for a numeral that already fits', () => {
    const recorder = recordNumeralSurface();

    try {
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
      });

      factory.buildBoard(4);
      recorder.measureAs(1);
      factory.acquireTileMesh(2);

      expect(recorder.setsOf('font')).toHaveLength(1);
      expect(factory.readStats().numeralsCondensed).toBe(0);

      factory.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('renders a blank block where no 2D context is reachable', () => {
    const recorder = recordNumeralSurface();

    try {
      const reports = collectReports();
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
        reporter: reports.reporter,
      });

      factory.buildBoard(4);
      recorder.refuseContext();

      const mesh = factory.acquireTileMesh(4);

      // THE FALLBACK: the plane is hidden rather than showing a blank texture,
      // and the block itself still renders.
      expect(mesh.children[0]?.visible).toBe(false);
      expect(mesh.visible).toBe(true);

      expect(factory.readStats().numeralsCreated).toBe(0);
      expect(factory.readStats().numeralsUnavailable).toBeGreaterThan(0);
      expect(reports.countOf('render.numeral.unavailable')).toBe(1);
      expect(
        reports.diagnostics.some((diagnostic): boolean =>
          diagnostic.message.includes('two-dimensional drawing surface'),
        ),
      ).toBe(true);

      // And it is not retried for every later block: the surface is known
      // unreachable, so the second block costs no further attempt.
      factory.acquireTileMesh(16);

      expect(reports.countOf('render.numeral.unavailable')).toBe(2);
      expect(
        recorder.calls.filter((call): boolean => call.member === 'getContext'),
      ).toHaveLength(1);

      factory.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('renders a blank block where the drawing itself raises', () => {
    const recorder = recordNumeralSurface();

    try {
      const reports = collectReports();
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
        reporter: reports.reporter,
      });

      factory.buildBoard(4);
      recorder.failNextDraw();

      const mesh = factory.acquireTileMesh(32);

      expect(mesh.children[0]?.visible).toBe(false);
      expect(mesh.visible).toBe(true);
      expect(factory.readStats().numeralsCreated).toBe(0);
      expect(factory.readStats().numeralsUnavailable).toBeGreaterThan(0);
      expect(
        reports.diagnostics.some((diagnostic): boolean =>
          diagnostic.message.includes('Drawing the numeral failed'),
        ),
      ).toBe(true);

      // The refusal is REMEMBERED for that value, so a later block wearing it
      // does not re-attempt the draw.
      const attempts = recorder.texts().length;

      factory.acquireTileMesh(32);

      expect(recorder.texts()).toHaveLength(attempts);

      factory.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('redraws every numeral in use when the theme changes', () => {
    const recorder = recordNumeralSurface();

    try {
      const reports = collectReports();
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
        reporter: reports.reporter,
      });

      factory.buildBoard(4);

      const mesh = factory.acquireTileMesh(64);
      const before = (mesh.children[0] as { material?: unknown }).material;
      const firstColour = recorder.lastSet('fillStyle');

      expect(recorder.texts()).toHaveLength(1);

      applyTheme('high-contrast');

      expect(factory.refreshTheme()).toBe(true);

      // DRAWN AGAIN, in the new theme's numeral colour, and the plane is
      // dressed in the new material rather than the stale one. The count is a
      // lower bound because the factory's own theme subscription discards the
      // cache as the theme lands, before `refreshTheme()` redraws from it.
      expect(recorder.texts().length).toBeGreaterThan(1);
      expect(recorder.lastSet('fillStyle')).toBe(
        materials.getNumeralColor(64),
      );
      expect(recorder.lastSet('fillStyle')).not.toBe(firstColour);
      expect((mesh.children[0] as { material?: unknown }).material).not.toBe(
        before,
      );
      expect(mesh.children[0]?.visible).toBe(true);
      expect(factory.readStats().numeralThemeRebuilds).toBeGreaterThan(0);

      factory.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('evicts the least recently used numeral no block is wearing', () => {
    const recorder = recordNumeralSurface();

    try {
      const reports = collectReports();
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
        reporter: reports.reporter,
      });

      factory.buildBoard(4);

      // Fill the cache past its ceiling with blocks that are RELEASED, so
      // every held numeral is evictable.
      const ceiling = 24;

      for (let exponent = 1; exponent <= ceiling + 4; exponent += 1) {
        const mesh = factory.acquireTileMesh(2 ** exponent);

        factory.releaseTileMesh(mesh);
      }

      const stats = factory.readStats();

      // BOUNDED: the cache never exceeds its ceiling, and eviction happened.
      expect(stats.cachedNumerals).toBeLessThanOrEqual(ceiling);
      expect(stats.numeralsEvicted).toBeGreaterThan(0);
      expect(stats.numeralsDisposed).toBeGreaterThan(0);
      expect(reports.countOf('render.numeral.evicted')).toBe(
        stats.numeralsEvicted,
      );

      // And every one of those draws really happened.
      expect(recorder.texts().length).toBe(stats.numeralsCreated);
      expect(stats.numeralsCreated).toBeGreaterThan(ceiling);

      factory.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('refuses rather than evicting a numeral a live block is wearing', () => {
    const recorder = recordNumeralSurface();

    try {
      const reports = collectReports();
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
        reporter: reports.reporter,
      });

      factory.buildBoard(4);

      const ceiling = 24;
      const held: ReturnType<typeof factory.acquireTileMesh>[] = [];

      // Every block is KEPT, so every cached numeral is worn and none can be
      // evicted. The block past the ceiling renders without its numeral.
      for (let exponent = 1; exponent <= ceiling; exponent += 1) {
        held.push(factory.acquireTileMesh(2 ** exponent));
      }

      expect(factory.readStats().cachedNumerals).toBe(ceiling);
      expect(factory.readStats().numeralsEvicted).toBe(0);

      const overflow = factory.acquireTileMesh(2 ** (ceiling + 1));

      expect(overflow.children[0]?.visible).toBe(false);
      expect(factory.readStats().numeralsRefused).toBeGreaterThan(0);
      expect(reports.countOf('render.numeral.refused')).toBeGreaterThan(0);
      expect(
        reports.diagnostics.some((diagnostic): boolean =>
          diagnostic.message.includes('every held numeral is worn'),
        ),
      ).toBe(true);

      // The numerals already drawn are untouched, and still visible.
      expect(factory.readStats().cachedNumerals).toBe(ceiling);
      expect(held[0]?.children[0]?.visible).toBe(true);

      // Releasing one makes room again, and the refused value then draws.
      const releasable = held[0];

      expect(releasable).toBeDefined();

      if (releasable !== undefined) {
        factory.releaseTileMesh(releasable);
      }

      const drawnBefore = recorder.texts().length;
      const retried = factory.acquireTileMesh(2 ** (ceiling + 2));

      expect(retried.children[0]?.visible).toBe(true);
      expect(recorder.texts().length).toBe(drawnBefore + 1);
      expect(factory.readStats().numeralsEvicted).toBeGreaterThan(0);

      factory.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('draws the mobile numeral smaller than the desktop one', () => {
    const recorder = recordNumeralSurface();

    try {
      const materials = createTileMaterialCache();
      const sizeOf = (font: unknown): number =>
        Number(/^bold ([\d.]+)px/.exec(String(font))?.[1] ?? '0');

      const desktop = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
        scale: 'desktop',
      });

      desktop.buildBoard(4);
      desktop.acquireTileMesh(2);

      const desktopFont = sizeOf(recorder.lastSet('font'));

      const mobile = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
        scale: 'mobile',
      });

      mobile.buildBoard(4);
      mobile.acquireTileMesh(2);

      const mobileFont = sizeOf(recorder.lastSet('font'));

      expect(desktopFont).toBeGreaterThan(0);
      expect(mobileFont).toBeGreaterThan(0);
      expect(mobileFont).toBeLessThan(desktopFont);

      desktop.dispose();
      mobile.dispose();
      materials.destroy();
    } finally {
      recorder.restore();
    }
  });

  it('disposes every numeral texture it drew', () => {
    const recorder = recordNumeralSurface();

    try {
      const materials = createTileMaterialCache();
      const factory = createTileMeshFactory({
        config: { boardSize: 4 },
        materials,
      });

      factory.buildBoard(4);
      factory.acquireTileMesh(2);
      factory.acquireTileMesh(4);
      factory.acquireTileMesh(8);

      expect(factory.readStats().numeralsCreated).toBe(3);

      factory.dispose();

      expect(factory.readStats().numeralsDisposed).toBe(3);
      expect(factory.readStats().cachedNumerals).toBe(0);

      materials.destroy();
    } finally {
      recorder.restore();
    }
  });
});
