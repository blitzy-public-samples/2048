// Unit suite pinning the vanilla-equivalent defaults of
// src/config/default-config.ts: the five rule values, the behaviour of the two
// exported merge rules, the factory's mutability contract and the frozen
// template's immutability.
//
// The vanilla constructs pinned here, each named in the test that pins it:
// boardSize 4 from the composition root, startTiles 2, spawn values [2, 4] at
// weights [0.9, 0.1], the merge condition and the face value a merge yields,
// the populated `mergedFrom` a merged tile carries, winValue 2048, and the
// operand shape both merge rules read.
//
// Scope held here: the schema — which members exist and what their types are —
// is pinned by tests/unit/config/rules-config.test.ts, and how a tile value is
// compared against winValue by the terminal-state suite. This file pins values
// and merge behaviour only, and records no snapshot.
//
// vitest.config.ts collects this file into the unit:dom-free project, so it
// runs without a DOM. It reads no DOM node, no persisted state and no
// environment value, opens no network call and needs no external fixture.

import { describe, expect, it, vi } from 'vitest';

import {
  createDefaultRulesConfig,
  DEFAULT_BOARD_SIZE,
  DEFAULT_RULES_CONFIG,
  defaultCanMerge,
  defaultProduceMergeValue,
} from '../../../src/config/default-config';
import type {
  MergeTileView,
  RulesConfig,
} from '../../../src/config/rules-config';

/* ===== 1. Operands ===== */

/**
 * `Math.random` as this environment supplied it, read at module scope before
 * any case installs a spy on it. The restoration case in section 11 compares
 * against this rather than against whatever it finds.
 */
const PRISTINE_MATH_RANDOM = Math.random;

/** The `{ x, y }` pair js/tile.js L11 saves into `previousPosition`. */
interface VanillaPosition {
  readonly x: number;
  readonly y: number;
}

interface VanillaTileShape extends MergeTileView {
  readonly x: number;
  readonly y: number;
  readonly previousPosition: VanillaPosition | null;
  readonly mergedFrom: readonly VanillaTileShape[] | null;
}

function unmergedTile(value: number, x = 0, y = 0): VanillaTileShape {
  return { x, y, value, previousPosition: { x, y }, mergedFrom: null };
}

function mergedTile(value: number, x = 0, y = 0): VanillaTileShape {
  const half = value / 2;

  return {
    x,
    y,
    value,
    previousPosition: null,
    mergedFrom: [unmergedTile(half, x, y), unmergedTile(half, x, y)],
  };
}

function emptyMergedFromTile(value: number): VanillaTileShape {
  return { x: 0, y: 0, value, previousPosition: null, mergedFrom: [] };
}

function producedValueFor(value: number): number {
  return defaultProduceMergeValue(unmergedTile(value), unmergedTile(value));
}

/* ===== 2. Subjects ===== */

/**
 * Calls one pure subject makes in a purity case. Repetition is what a static
 * purity check stands on: a subject reading randomness, a clock or any other
 * ambient source would not answer identically across every pass.
 */
const PURITY_REPEATS = 32;

/**
 * Runs `assert` twice, once against each carrier of the defaults: the frozen
 * template, then a freshly built config. A value that diverges between the two
 * fails the assertion.
 *
 * @param assert Assertion to run, receiving the config and a label naming the
 *   carrier for the failure message.
 */
function forEachDefaultConfig(
  assert: (config: RulesConfig, label: string) => void,
): void {
  assert(DEFAULT_RULES_CONFIG, 'DEFAULT_RULES_CONFIG');
  assert(createDefaultRulesConfig(), 'createDefaultRulesConfig()');
}

describe('vanilla-equivalent rule values', () => {
  it('pins boardSize 4 (js/application.js L3)', () => {
    forEachDefaultConfig((config, label) => {
      expect(config.boardSize, label).toBe(4);
    });
  });

  it('exports 4 as the board-size authority (js/application.js L3)', () => {
    expect(DEFAULT_BOARD_SIZE).toBe(4);

    forEachDefaultConfig((config, label) => {
      expect(config.boardSize, label).toBe(DEFAULT_BOARD_SIZE);
    });
  });

  it('pins winValue 2048 (js/game_manager.js L170)', () => {
    forEachDefaultConfig((config, label) => {
      expect(config.winValue, label).toBe(2048);
    });
  });

  it('pins startTiles 2 (js/game_manager.js L7)', () => {
    forEachDefaultConfig((config, label) => {
      expect(config.startTiles, label).toBe(2);
    });
  });

  it('pins spawn values [2, 4] (js/game_manager.js L71)', () => {
    forEachDefaultConfig((config, label) => {
      expect(config.spawn.values, label).toEqual([2, 4]);
    });
  });

  it('pins spawn weights [0.9, 0.1] (js/game_manager.js L71)', () => {
    forEachDefaultConfig((config, label) => {
      expect(config.spawn.weights, label).toEqual([0.9, 0.1]);
    });
  });

  it('carries both merge rules as functions', () => {
    forEachDefaultConfig((config, label) => {
      expect(config.merge.canMerge, label).toBeTypeOf('function');
      expect(config.merge.produce, label).toBeTypeOf('function');
    });
  });
});

describe('spawn distribution (js/game_manager.js L71)', () => {
  it('pairs weight 0.9 with value 2 and weight 0.1 with value 4', () => {
    forEachDefaultConfig((config, label) => {
      const { values, weights } = config.spawn;

      expect(values[0], label).toBe(2);
      expect(weights[0], label).toBe(0.9);
      expect(values[1], label).toBe(4);
      expect(weights[1], label).toBe(0.1);
    });
  });

  it('holds one weight per value', () => {
    forEachDefaultConfig((config, label) => {
      const { values, weights } = config.spawn;

      expect(values, label).toHaveLength(2);
      expect(weights, label).toHaveLength(values.length);
    });
  });

  it('holds weights summing to 1', () => {
    forEachDefaultConfig((config, label) => {
      const sum = config.spawn.weights.reduce(
        (total, weight) => total + weight,
        0,
      );

      expect(sum, label).toBeCloseTo(1);
    });
  });
});

describe('member set', () => {
  it('carries exactly the five configured rule members', () => {
    forEachDefaultConfig((config, label) => {
      expect(Object.keys(config).sort(), label).toEqual([
        'boardSize',
        'merge',
        'spawn',
        'startTiles',
        'winValue',
      ]);
    });
  });

  it('carries no member beyond the two on each nested rule', () => {
    forEachDefaultConfig((config, label) => {
      expect(Object.keys(config.spawn).sort(), label).toEqual([
        'values',
        'weights',
      ]);
      expect(Object.keys(config.merge).sort(), label).toEqual([
        'canMerge',
        'produce',
      ]);
    });
  });
});

describe('defaultProduceMergeValue (js/game_manager.js L157)', () => {
  it('yields double the value across the vanilla ramp', () => {
    expect(producedValueFor(2)).toBe(4);
    expect(producedValueFor(4)).toBe(8);
    expect(producedValueFor(8)).toBe(16);
    expect(producedValueFor(64)).toBe(128);
    expect(producedValueFor(1024)).toBe(2048);
  });

  it('applies no cap at winValue', () => {
    expect(producedValueFor(2048)).toBe(4096);
    expect(producedValueFor(4096)).toBe(8192);
  });

  it('returns the same value for the same operands', () => {
    const moving = unmergedTile(32, 1, 1);
    const target = unmergedTile(32, 2, 1);
    const first = defaultProduceMergeValue(moving, target);
    const second = defaultProduceMergeValue(moving, target);

    expect(second).toBe(first);
    expect(second).toBe(64);
  });

  it('mutates neither operand', () => {
    const moving = unmergedTile(16, 3, 2);
    const target = unmergedTile(16, 3, 3);

    defaultProduceMergeValue(moving, target);
    expect(moving.value).toBe(16);
    expect(target.value).toBe(16);
    expect(moving.mergedFrom).toBeNull();
    expect(target.mergedFrom).toBeNull();
  });
});

describe('defaultCanMerge (js/game_manager.js L156)', () => {
  it('merges equal values into an unmerged target', () => {
    const moving = unmergedTile(4, 1, 0);
    const target = unmergedTile(4, 2, 0);

    expect(defaultCanMerge(moving, target)).toBe(true);
  });

  it('blocks equal values when the target already merged', () => {
    const moving = unmergedTile(4, 1, 0);
    const target = mergedTile(4, 2, 0);

    expect(target.mergedFrom).toHaveLength(2);
    expect(defaultCanMerge(moving, target)).toBe(false);
  });

  it('blocks different values against an unmerged target', () => {
    const moving = unmergedTile(2, 1, 0);
    const target = unmergedTile(4, 2, 0);

    expect(defaultCanMerge(moving, target)).toBe(false);
  });

  it('blocks different values against a merged target', () => {
    const moving = unmergedTile(2, 1, 0);
    const target = mergedTile(4, 2, 0);

    expect(defaultCanMerge(moving, target)).toBe(false);
  });

  it('reads the target merge state and not the moving one', () => {
    const moving = mergedTile(4, 1, 0);
    const target = unmergedTile(4, 2, 0);

    expect(moving.mergedFrom).toHaveLength(2);
    expect(defaultCanMerge(moving, target)).toBe(true);
  });

  it('reads a null target mergedFrom as unmerged', () => {
    const target = unmergedTile(8, 1, 1);

    expect(target.mergedFrom).toBeNull();
    expect(defaultCanMerge(unmergedTile(8, 0, 1), target)).toBe(true);
  });

  it('reads an empty target mergedFrom as merged', () => {
    const target = emptyMergedFromTile(8);

    expect(target.mergedFrom).toHaveLength(0);
    expect(defaultCanMerge(unmergedTile(8, 0, 1), target)).toBe(false);
  });

  it('returns the same verdict for the same operands', () => {
    const moving = unmergedTile(16, 1, 2);
    const permitted = unmergedTile(16, 2, 2);
    const blocked = mergedTile(16, 3, 2);

    expect(defaultCanMerge(moving, permitted)).toBe(true);
    expect(defaultCanMerge(moving, permitted)).toBe(true);
    expect(defaultCanMerge(moving, blocked)).toBe(false);
    expect(defaultCanMerge(moving, blocked)).toBe(false);
  });

  it('mutates neither operand', () => {
    const moving = unmergedTile(2, 0, 1);
    const target = unmergedTile(2, 0, 2);

    defaultCanMerge(moving, target);
    expect(moving.value).toBe(2);
    expect(target.value).toBe(2);
    expect(moving.mergedFrom).toBeNull();
    expect(target.mergedFrom).toBeNull();
  });
});

describe('merge-rule wiring', () => {
  it('installs the exported merge rules as the defaults', () => {
    forEachDefaultConfig((config, label) => {
      expect(config.merge.canMerge, label).toBe(defaultCanMerge);
      expect(config.merge.produce, label).toBe(defaultProduceMergeValue);
    });
  });

  it('shares one function instance across every carrier', () => {
    const first = createDefaultRulesConfig();
    const second = createDefaultRulesConfig();
    const template = DEFAULT_RULES_CONFIG;

    expect(second.merge.canMerge).toBe(first.merge.canMerge);
    expect(second.merge.produce).toBe(first.merge.produce);
    expect(template.merge.canMerge).toBe(first.merge.canMerge);
    expect(template.merge.produce).toBe(first.merge.produce);
  });
});

describe('createDefaultRulesConfig()', () => {
  it('returns an equal but distinct object on every call', () => {
    const first = createDefaultRulesConfig();
    const second = createDefaultRulesConfig();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('allocates every nested object and array afresh', () => {
    const first = createDefaultRulesConfig();
    const second = createDefaultRulesConfig();

    expect(second.spawn).not.toBe(first.spawn);
    expect(second.spawn.values).not.toBe(first.spawn.values);
    expect(second.spawn.weights).not.toBe(first.spawn.weights);
    expect(second.merge).not.toBe(first.merge);
  });

  it('shares no object with the frozen template', () => {
    const config = createDefaultRulesConfig();
    const template = DEFAULT_RULES_CONFIG;

    expect(config).not.toBe(template);
    expect(config.spawn).not.toBe(template.spawn);
    expect(config.spawn.values).not.toBe(template.spawn.values);
    expect(config.spawn.weights).not.toBe(template.spawn.weights);
    expect(config.merge).not.toBe(template.merge);
  });

  it('returns an object frozen at no level', () => {
    const config = createDefaultRulesConfig();

    expect(Object.isFrozen(config)).toBe(false);
    expect(Object.isFrozen(config.spawn)).toBe(false);
    expect(Object.isFrozen(config.spawn.values)).toBe(false);
    expect(Object.isFrozen(config.spawn.weights)).toBe(false);
    expect(Object.isFrozen(config.merge)).toBe(false);
  });

  it('accepts a mutation without affecting a later call', () => {
    const mutated = createDefaultRulesConfig();

    mutated.boardSize = 3;
    mutated.winValue = 64;
    mutated.startTiles = 1;
    mutated.spawn.values.push(8);
    mutated.spawn.weights[0] = 0.5;
    mutated.merge.canMerge = () => false;

    const pristine = createDefaultRulesConfig();

    expect(pristine.boardSize).toBe(4);
    expect(pristine.winValue).toBe(2048);
    expect(pristine.startTiles).toBe(2);
    expect(pristine.spawn.values).toEqual([2, 4]);
    expect(pristine.spawn.weights).toEqual([0.9, 0.1]);
    expect(pristine.merge.canMerge).toBe(defaultCanMerge);
  });

  it('accepts a mutation without affecting the frozen template', () => {
    const mutated = createDefaultRulesConfig();

    mutated.boardSize = 3;
    mutated.spawn.values.push(8);

    expect(DEFAULT_RULES_CONFIG.boardSize).toBe(4);
    expect(DEFAULT_RULES_CONFIG.spawn.values).toEqual([2, 4]);
  });
});

describe('DEFAULT_RULES_CONFIG', () => {
  it('is frozen at every level', () => {
    const template = DEFAULT_RULES_CONFIG;

    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template.spawn)).toBe(true);
    expect(Object.isFrozen(template.spawn.values)).toBe(true);
    expect(Object.isFrozen(template.spawn.weights)).toBe(true);
    expect(Object.isFrozen(template.merge)).toBe(true);
  });

  it('throws on a rule-value assignment and keeps the value', () => {
    expect(() => {
      DEFAULT_RULES_CONFIG.boardSize = 3;
    }).toThrow(TypeError);

    expect(() => {
      DEFAULT_RULES_CONFIG.winValue = 64;
    }).toThrow(TypeError);

    expect(() => {
      DEFAULT_RULES_CONFIG.startTiles = 1;
    }).toThrow(TypeError);

    expect(DEFAULT_RULES_CONFIG.boardSize).toBe(4);
    expect(DEFAULT_RULES_CONFIG.winValue).toBe(2048);
    expect(DEFAULT_RULES_CONFIG.startTiles).toBe(2);
  });

  it('throws on a nested rule assignment and keeps the rule', () => {
    expect(() => {
      DEFAULT_RULES_CONFIG.spawn.weights = [0.5, 0.5];
    }).toThrow(TypeError);

    expect(() => {
      DEFAULT_RULES_CONFIG.merge.canMerge = () => false;
    }).toThrow(TypeError);

    expect(DEFAULT_RULES_CONFIG.spawn.weights).toEqual([0.9, 0.1]);
    expect(DEFAULT_RULES_CONFIG.merge.canMerge).toBe(defaultCanMerge);
  });

  it('throws on an element write into a spawn array', () => {
    expect(() => {
      DEFAULT_RULES_CONFIG.spawn.values[0] = 8;
    }).toThrow(TypeError);

    expect(() => {
      DEFAULT_RULES_CONFIG.spawn.weights[1] = 0.5;
    }).toThrow(TypeError);

    expect(DEFAULT_RULES_CONFIG.spawn.values).toEqual([2, 4]);
    expect(DEFAULT_RULES_CONFIG.spawn.weights).toEqual([0.9, 0.1]);
  });

  it('throws on a push onto a spawn array', () => {
    expect(() => {
      DEFAULT_RULES_CONFIG.spawn.values.push(8);
    }).toThrow(TypeError);

    expect(() => {
      DEFAULT_RULES_CONFIG.spawn.weights.push(0.5);
    }).toThrow(TypeError);

    expect(DEFAULT_RULES_CONFIG.spawn.values).toEqual([2, 4]);
    expect(DEFAULT_RULES_CONFIG.spawn.weights).toEqual([0.9, 0.1]);
  });

  it('throws on adding a member and keeps the member set', () => {
    expect(() => {
      (DEFAULT_RULES_CONFIG as unknown as Record<string, number>).extra = 1;
    }).toThrow(TypeError);

    expect(Object.keys(DEFAULT_RULES_CONFIG).sort()).toEqual([
      'boardSize',
      'merge',
      'spawn',
      'startTiles',
      'winValue',
    ]);
  });
});

/* ===== 11. Purity ===== */

describe('purity', () => {
  it('builds the same configuration on every call', () => {
    const built = Array.from({ length: PURITY_REPEATS }, () =>
      createDefaultRulesConfig()
    );

    for (const config of built) {
      expect(config).toEqual(built[0]);
      expect(config).toEqual(DEFAULT_RULES_CONFIG);
    }
  });

  it('answers both merge rules the same way on every call', () => {
    const moving = unmergedTile(4, 1, 0);
    const target = unmergedTile(4, 2, 0);
    const blocked = unmergedTile(8, 3, 0);

    for (let pass = 0; pass < PURITY_REPEATS; pass += 1) {
      expect(defaultCanMerge(moving, target)).toBe(true);
      expect(defaultCanMerge(moving, blocked)).toBe(false);
      expect(defaultProduceMergeValue(moving, target)).toBe(8);
    }
  });

  it('leaves both merge operands unchanged', () => {
    const moving = unmergedTile(4, 1, 0);
    const target = unmergedTile(4, 2, 0);
    const movingBefore = structuredClone(moving);
    const targetBefore = structuredClone(target);

    defaultCanMerge(moving, target);
    defaultProduceMergeValue(moving, target);

    expect(moving).toEqual(movingBefore);
    expect(target).toEqual(targetBefore);
  });

  // Self-contained: the spy this case asserts the restoration of is installed
  // by this case. Reading `Math.random` without installing one would pass
  // whether or not restoration works, because it would only be describing the
  // state the file started in.
  it('leaves Math.random unspied once a spy is restored', () => {
    expect(vi.isMockFunction(Math.random)).toBe(false);

    const randomSpy = vi.spyOn(Math, 'random');

    expect(vi.isMockFunction(Math.random)).toBe(true);
    expect(Math.random).toBe(randomSpy);
    expect(Math.random).not.toBe(PRISTINE_MATH_RANDOM);

    vi.restoreAllMocks();

    expect(vi.isMockFunction(Math.random)).toBe(false);
    expect(Math.random).toBe(PRISTINE_MATH_RANDOM);
  });
});
