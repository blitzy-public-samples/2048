// Contract suite for reduced motion as ONE effective preference, AAP R9.
//
// The accessibility surface offers three settings — `'system'`, `'reduce'` and
// `'allow'` — but `prefers-reduced-motion` answers only the operating system.
// Two of the three therefore have no CSS media query that expresses them, and
// nothing in the style layer or the on-screen controls could see them.
//
// Three properties are pinned here:
//
//   reflection   the effective value is written to the document element as an
//                explicit `'true'` or `'false'`, never removed, because the
//                style layer distinguishes an explicit `'false'` — keep
//                motion — from an absent attribute, where the operating system
//                decides.
//   consumption  the on-screen controls resolve the value in a fixed order,
//                pinned value first, then the reflected attribute, then the
//                media query, so an explicit setting reaches them.
//   liveness     a tween reads the preference once, at construction, so the
//                group is the member that follows a later change: it steps its
//                held tweens to their FINAL values rather than dropping them
//                part-way, which is what `clear()` did.
//
// `setReducedMotionOverride` is module state in src/render/webgl-support.ts, so
// every test restores it.

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTween,
  createTweenGroup,
  easeInOut,
} from '../../../src/render/animations';
import {
  queryReducedMotion,
  setReducedMotionOverride,
} from '../../../src/render/webgl-support';
import { mountOnScreenControls } from '../../../src/input/on-screen-controls';
import { createInputManager } from '../../../src/input/input-manager';
import {
  REDUCED_MOTION_ATTRIBUTE,
  createPreferenceStore,
  readReflectedReducedMotion,
  reducedMotionOverrideFor,
  reflectReducedMotion,
} from '../../../src/ui/a11y/settings';

afterEach(() => {
  setReducedMotionOverride(null);
  document.documentElement.removeAttribute(REDUCED_MOTION_ATTRIBUTE);
  document.body.innerHTML = '';
});

/** A mount host for the controls, plus the manager they publish through. */
const controlsFixture = (): {
  host: ReturnType<typeof createInputManager>;
  mount: HTMLElement;
} => {
  const mount = document.createElement('div');

  mount.id = 'on-screen-controls';
  document.body.appendChild(mount);

  return { host: createInputManager({}), mount };
};

/* ===== 1. The effective value is reflected (F-06) ===== */

describe('the effective reduced-motion value is reflected', () => {
  it('writes an explicit true', () => {
    expect(reflectReducedMotion(document.documentElement, true)).toBe(true);
    expect(
      document.documentElement.getAttribute(REDUCED_MOTION_ATTRIBUTE),
    ).toBe('true');
  });

  it('writes an explicit false rather than removing the attribute', () => {
    reflectReducedMotion(document.documentElement, true);
    reflectReducedMotion(document.documentElement, false);

    // An absent attribute would mean "the operating system decides"; an
    // explicit `false` means the user asked to keep motion.
    expect(
      document.documentElement.getAttribute(REDUCED_MOTION_ATTRIBUTE),
    ).toBe('false');
  });

  it('does nothing and reports nothing for an absent target', () => {
    expect(reflectReducedMotion(null, true)).toBe(false);
  });

  it('reads back both explicit values', () => {
    reflectReducedMotion(document.documentElement, true);
    expect(readReflectedReducedMotion(document.documentElement)).toBe(true);

    reflectReducedMotion(document.documentElement, false);
    expect(readReflectedReducedMotion(document.documentElement)).toBe(false);
  });

  it('reads null for an absent or unrecognised attribute', () => {
    expect(readReflectedReducedMotion(document.documentElement)).toBe(null);

    document.documentElement.setAttribute(REDUCED_MOTION_ATTRIBUTE, 'maybe');

    expect(readReflectedReducedMotion(document.documentElement)).toBe(null);
    expect(readReflectedReducedMotion(null)).toBe(null);
  });
});

/* ===== 2. The setting reaches the render store (F-06) ===== */

describe('the motion setting drives the render store', () => {
  it('maps each setting onto the tri-state override', () => {
    expect(reducedMotionOverrideFor('reduce')).toBe(true);
    expect(reducedMotionOverrideFor('allow')).toBe(false);
    expect(reducedMotionOverrideFor('system')).toBe(null);
  });

  it('forces the store on for an explicit reduce', () => {
    const store = createPreferenceStore({});

    store.setMotionSetting('reduce');
    setReducedMotionOverride(store.reducedMotionOverride());

    expect(queryReducedMotion()).toBe(true);
    expect(store.isReducedMotion()).toBe(true);
  });

  it('forces the store off for an explicit allow', () => {
    const store = createPreferenceStore({});

    store.setMotionSetting('reduce');
    setReducedMotionOverride(store.reducedMotionOverride());
    expect(queryReducedMotion()).toBe(true);

    store.setMotionSetting('allow');
    setReducedMotionOverride(store.reducedMotionOverride());

    // The operating system is not consulted: `allow` is an explicit answer.
    expect(queryReducedMotion()).toBe(false);
    expect(store.isReducedMotion()).toBe(false);
  });

  it('returns the store to the media query for system', () => {
    const store = createPreferenceStore({});

    store.setMotionSetting('reduce');
    setReducedMotionOverride(store.reducedMotionOverride());

    store.setMotionSetting('system');

    expect(store.reducedMotionOverride()).toBe(null);
  });

  it('notifies subscribers under the reducedMotion key', () => {
    const store = createPreferenceStore({});
    const changes: readonly string[][] = [];
    const collected: string[][] = changes as string[][];

    store.subscribe((_snapshot, changed): void => {
      collected.push([...changed]);
    });

    store.setMotionSetting('reduce');

    expect(collected.some((keys) => keys.includes('reducedMotion'))).toBe(true);
  });
});

/* ===== 3. The controls consume the effective value (F-06) ===== */

describe('the on-screen controls consume the effective value', () => {
  it('honours a pinned value over the media query', () => {
    const { host, mount } = controlsFixture();
    const controls = mountOnScreenControls({
      host,
      ownerDocument: document,
      mount,
      reducedMotion: true,
    });

    expect(controls.isReducedMotion()).toBe(true);
    expect(controls.root?.getAttribute(REDUCED_MOTION_ATTRIBUTE)).toBe('true');
    expect(
      controls.root?.classList.contains('on-screen-controls-animated'),
    ).toBe(false);

    controls.unmount();
  });

  it('honours the reflected attribute when nothing is pinned', () => {
    reflectReducedMotion(document.documentElement, true);

    const { host, mount } = controlsFixture();
    const controls = mountOnScreenControls({
      host,
      ownerDocument: document,
      mount,
    });

    expect(controls.isReducedMotion()).toBe(true);

    controls.unmount();
  });

  it('honours an explicit allow in the reflected attribute', () => {
    reflectReducedMotion(document.documentElement, false);

    const { host, mount } = controlsFixture();
    const controls = mountOnScreenControls({
      host,
      ownerDocument: document,
      mount,
    });

    expect(controls.isReducedMotion()).toBe(false);
    expect(
      controls.root?.classList.contains('on-screen-controls-animated'),
    ).toBe(true);

    controls.unmount();
  });

  it('takes a later value through setReducedMotion', () => {
    const { host, mount } = controlsFixture();
    const controls = mountOnScreenControls({
      host,
      ownerDocument: document,
      mount,
      reducedMotion: false,
    });

    expect(controls.isReducedMotion()).toBe(false);

    controls.setReducedMotion(true);

    expect(controls.isReducedMotion()).toBe(true);
    expect(controls.root?.getAttribute(REDUCED_MOTION_ATTRIBUTE)).toBe('true');

    controls.unmount();
  });

  it('resolves from the attribute again when the pin is released', () => {
    reflectReducedMotion(document.documentElement, true);

    const { host, mount } = controlsFixture();
    const controls = mountOnScreenControls({
      host,
      ownerDocument: document,
      mount,
      reducedMotion: false,
    });

    expect(controls.isReducedMotion()).toBe(false);

    controls.setReducedMotion(null);

    expect(controls.isReducedMotion()).toBe(true);

    controls.unmount();
  });

  it('follows a later write to the reflected attribute', async () => {
    reflectReducedMotion(document.documentElement, false);

    const { host, mount } = controlsFixture();
    // No pinned value, which is how src/main.ts mounts them: the reflected
    // attribute is then the single source, and a pin would shadow it.
    const controls = mountOnScreenControls({
      host,
      ownerDocument: document,
      mount,
    });

    expect(controls.isReducedMotion()).toBe(false);

    reflectReducedMotion(document.documentElement, true);

    // The observer's callback is a microtask, so the write is seen on the next
    // turn of the queue rather than synchronously.
    await Promise.resolve();
    await new Promise((resolve): void => {
      setTimeout(resolve, 0);
    });

    expect(controls.isReducedMotion()).toBe(true);
    expect(controls.root?.getAttribute(REDUCED_MOTION_ATTRIBUTE)).toBe('true');
    expect(
      controls.root?.classList.contains('on-screen-controls-animated'),
    ).toBe(false);

    controls.unmount();
  });

  it('a pinned value shadows a later attribute write', async () => {
    reflectReducedMotion(document.documentElement, false);

    const { host, mount } = controlsFixture();
    const controls = mountOnScreenControls({
      host,
      ownerDocument: document,
      mount,
      reducedMotion: false,
    });

    reflectReducedMotion(document.documentElement, true);
    await new Promise((resolve): void => {
      setTimeout(resolve, 0);
    });

    // This is why src/main.ts supplies no pin: it would make the attribute
    // unable to move the controls.
    expect(controls.isReducedMotion()).toBe(false);

    controls.unmount();
  });

  it('removes the attribute it wrote on unmount', () => {
    const { host, mount } = controlsFixture();
    const controls = mountOnScreenControls({
      host,
      ownerDocument: document,
      mount,
      reducedMotion: true,
    });

    const root = controls.root;

    controls.unmount();

    expect(root?.hasAttribute(REDUCED_MOTION_ATTRIBUTE)).toBe(false);
  });
});

/* ===== 4. A group follows a live change (F-26) ===== */

describe('a tween group follows the preference while it is alive', () => {
  /** A two-stop numeric tween, 100ms with no delay. */
  const numericTween = (): ReturnType<typeof createTween<number>> =>
    createTween<number>(
      {
        name: 'move',
        duration: 100,
        delay: 0,
        stops: [
          { offset: 0, value: 0 },
          { offset: 1, value: 100 },
        ],
        interpolate: (from, to, t): number => from + (to - from) * t,
        easing: easeInOut,
      },
      { reducedMotion: false },
    );

  it('completes an active tween when reduction turns on', () => {
    const group = createTweenGroup();
    const tween = group.add(numericTween());

    group.advance(20);

    expect(tween.isComplete()).toBe(false);
    expect(tween.value()).toBeLessThan(100);

    setReducedMotionOverride(true);

    // Stepped to its final value, not dropped part-way.
    expect(tween.isComplete()).toBe(true);
    expect(tween.value()).toBe(100);
    expect(group.size()).toBe(0);

    group.dispose();
  });

  it('reports no outstanding work after the preference turns on', () => {
    const group = createTweenGroup();

    group.add(numericTween());
    group.advance(10);

    expect(group.hasOutstandingWork()).toBe(true);

    setReducedMotionOverride(true);

    expect(group.hasOutstandingWork()).toBe(false);

    group.dispose();
  });

  it('leaves an active tween alone when reduction turns off', () => {
    setReducedMotionOverride(true);

    const group = createTweenGroup();

    setReducedMotionOverride(false);

    const tween = group.add(numericTween());

    group.advance(20);

    expect(tween.isComplete()).toBe(false);

    group.dispose();
  });

  it('applies the final value in clear()', () => {
    const group = createTweenGroup();
    const tween = group.add(numericTween());

    group.advance(30);
    expect(tween.value()).toBeLessThan(100);

    expect(group.clear()).toBe(1);

    // The defect: `clear()` released without completing, leaving the surface
    // the tween drove frozen part-way through its interval.
    expect(tween.isComplete()).toBe(true);
    expect(tween.value()).toBe(100);

    group.dispose();
  });

  it('completes what it still holds on dispose', () => {
    const group = createTweenGroup();
    const tween = group.add(numericTween());

    group.advance(30);
    group.dispose();

    expect(tween.isComplete()).toBe(true);
    expect(tween.value()).toBe(100);
  });

  it('stops following once disposed', () => {
    const group = createTweenGroup();

    group.dispose();

    const tween = group.add(numericTween());

    group.advance(20);
    setReducedMotionOverride(true);

    // The subscription was released, so the group did not act on the change.
    expect(tween.isComplete()).toBe(false);
  });

  it('is safe to dispose more than once', () => {
    const group = createTweenGroup();

    group.dispose();

    expect(() => {
      group.dispose();
    }).not.toThrow();
  });

  it('does not subscribe when following is declined', () => {
    const group = createTweenGroup({ followReducedMotion: false });
    const tween = group.add(numericTween());

    group.advance(20);
    setReducedMotionOverride(true);

    expect(tween.isComplete()).toBe(false);

    group.dispose();
  });

  it('counts the tweens the preference completed', () => {
    const counts: { name: string; value: number }[] = [];
    const group = createTweenGroup({
      reporter: {
        onCount: (count): void => {
          counts.push({ name: count.name, value: count.value });
        },
        onDiagnostic: (): void => {
          // Not asserted here.
        },
        onTiming: (): void => {
          // Not asserted here.
        },
      },
    });

    group.add(numericTween());
    group.add(numericTween());
    group.advance(10);

    setReducedMotionOverride(true);

    const reduced = counts.filter(
      (entry) => entry.name === 'render.animations.tween.reduced',
    );

    expect(reduced.length).toBe(1);
    expect(reduced[0]?.value).toBe(2);

    group.dispose();
  });
});
