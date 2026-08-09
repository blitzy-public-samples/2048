// Contract suite for the metrics registry's dynamic-series handling, Rule 3.
//
// This suite pins both halves of the fix: that resolution happens once per
// identifier, and that holding the handle changed none of the recorded values.

import { describe, expect, it } from 'vitest';

import {
  METRIC_LABELS,
  METRIC_NAMES,
  MetricsRegistry,
  createMetricsRegistry,
} from '../../../src/observability/metrics';

/** Counts calls to one private resolver. */
const countResolutions = (
  registry: MetricsRegistry,
  member: 'histogramSeries' | 'gaugeSeries' | 'counterSeries',
): (() => number) => {
  const host = registry as unknown as Record<string, unknown>;
  const original = host[member] as (...args: unknown[]) => unknown;

  let calls = 0;

  host[member] = function patched(this: unknown, ...args: unknown[]): unknown {
    calls += 1;

    return original.apply(this, args);
  };

  return (): number => calls;
};

/** Reads the sample lines of one family from the exported text. */
const familyLines = (text: string, family: string): readonly string[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith(family) && !line.startsWith('#'));

describe('span durations resolve their series once', () => {
  it('resolves once across many records of one span', () => {
    const registry = createMetricsRegistry({});
    const resolutions = countResolutions(registry, 'histogramSeries');

    for (let index = 0; index < 25; index += 1) {
      registry.recordSpanDuration('engine.turn', index);
    }

    // Before the fix this was 25: every frame paid the whole chain again.
    expect(resolutions()).toBe(1);
  });

  it('resolves once per distinct span', () => {
    const registry = createMetricsRegistry({});
    const resolutions = countResolutions(registry, 'histogramSeries');

    for (let round = 0; round < 4; round += 1) {
      registry.recordSpanDuration('engine.turn', 1);
      registry.recordSpanDuration('render.frame', 2);
      registry.recordSpanDuration('hook.dispatch', 3);
    }

    expect(resolutions()).toBe(3);
  });

  it('accumulates every observation into one series', () => {
    const registry = createMetricsRegistry({});

    for (let index = 0; index < 10; index += 1) {
      registry.recordSpanDuration('engine.turn', 5);
    }

    const text = registry.toPrometheusText();
    const counts = familyLines(
      text,
      `${METRIC_NAMES.spanDurationMilliseconds}_count`,
    );

    // One series, holding all ten observations: caching the handle must not
    // split or drop samples.
    expect(counts).toHaveLength(1);
    expect(counts[0]).toContain('10');
    expect(counts[0]).toContain(`${METRIC_LABELS.span}="engine.turn"`);
  });

  it('keeps the sum of the observations', () => {
    const registry = createMetricsRegistry({});

    registry.recordSpanDuration('engine.turn', 2);
    registry.recordSpanDuration('engine.turn', 3);
    registry.recordSpanDuration('engine.turn', 5);

    const sums = familyLines(
      registry.toPrometheusText(),
      `${METRIC_NAMES.spanDurationMilliseconds}_sum`,
    );

    expect(sums).toHaveLength(1);
    expect(sums[0]).toContain('10');
  });

  it('keeps one series per span name', () => {
    const registry = createMetricsRegistry({});

    registry.recordSpanDuration('engine.turn', 1);
    registry.recordSpanDuration('render.frame', 1);

    const counts = familyLines(
      registry.toPrometheusText(),
      `${METRIC_NAMES.spanDurationMilliseconds}_count`,
    );

    expect(counts).toHaveLength(2);
  });

  it('still rejects an unusable duration without caching anything', () => {
    const registry = createMetricsRegistry({});
    const resolutions = countResolutions(registry, 'histogramSeries');

    registry.recordSpanDuration('engine.turn', -1);
    registry.recordSpanDuration('engine.turn', Number.NaN);
    registry.recordSpanDuration('', 1);

    // Rejected before any series is asked for.
    expect(resolutions()).toBe(0);
    expect(registry.snapshot().rejected).toBeGreaterThan(0);
  });

  it('records normally after a rejected call', () => {
    const registry = createMetricsRegistry({});

    registry.recordSpanDuration('engine.turn', -1);
    registry.recordSpanDuration('engine.turn', 4);

    const counts = familyLines(
      registry.toPrometheusText(),
      `${METRIC_NAMES.spanDurationMilliseconds}_count`,
    );

    expect(counts).toHaveLength(1);
    expect(counts[0]).toContain('1');
  });
});

describe('health checks resolve their series once', () => {
  it('resolves once across many records of one check', () => {
    const registry = createMetricsRegistry({});
    const resolutions = countResolutions(registry, 'gaugeSeries');

    for (let index = 0; index < 12; index += 1) {
      registry.recordHealthCheck('webgl', index % 2 === 0);
    }

    expect(resolutions()).toBe(1);
  });

  it('holds the last value written', () => {
    const registry = createMetricsRegistry({});

    registry.recordHealthCheck('webgl', true);
    registry.recordHealthCheck('webgl', false);

    const lines = familyLines(
      registry.toPrometheusText(),
      METRIC_NAMES.healthCheckStatus,
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].trim().endsWith('0')).toBe(true);
  });

  it('records 1 only for exactly true', () => {
    const registry = createMetricsRegistry({});

    registry.recordHealthCheck('webgl', true);

    const lines = familyLines(
      registry.toPrometheusText(),
      METRIC_NAMES.healthCheckStatus,
    );

    expect(lines[0].trim().endsWith('1')).toBe(true);
  });

  it('keeps one series per check name', () => {
    const registry = createMetricsRegistry({});
    const resolutions = countResolutions(registry, 'gaugeSeries');

    for (const check of ['webgl', 'storage', 'pointer', 'raf']) {
      registry.recordHealthCheck(check, true);
      registry.recordHealthCheck(check, false);
    }

    expect(resolutions()).toBe(4);
    expect(
      familyLines(registry.toPrometheusText(), METRIC_NAMES.healthCheckStatus),
    ).toHaveLength(4);
  });

  it('rejects an empty check name before resolving', () => {
    const registry = createMetricsRegistry({});
    const resolutions = countResolutions(registry, 'gaugeSeries');

    registry.recordHealthCheck('', true);

    expect(resolutions()).toBe(0);
    expect(registry.snapshot().rejected).toBeGreaterThan(0);
  });
});

describe('rng cursors resolve their series once per substream', () => {
  it('resolves once per substream across repeated folds', () => {
    const registry = createMetricsRegistry({});
    const resolutions = countResolutions(registry, 'counterSeries');

    for (let round = 1; round <= 6; round += 1) {
      registry.recordRngCursors({
        'spawn-value': round,
        'spawn-position': round * 2,
        'relic-draw': round,
        'rarity-weight': round,
      });
    }

    expect(resolutions()).toBe(4);
  });

  it('folds absolutes by their increase', () => {
    const registry = createMetricsRegistry({});

    registry.recordRngCursors({ 'spawn-value': 10 });
    registry.recordRngCursors({ 'spawn-value': 14 });

    const lines = familyLines(
      registry.toPrometheusText(),
      METRIC_NAMES.rngDrawsTotal,
    );

    // The canonical substream tuple is folded, so the family carries one
    // series per named substream and the one under test is selected by label.
    const spawnValue = lines.filter((line: string): boolean =>
      line.includes('stream="spawn-value"'),
    );

    expect(spawnValue).toHaveLength(1);
    expect(spawnValue[0].trim().endsWith('14')).toBe(true);
  });

  it('adds nothing for a repeated identical fold', () => {
    const registry = createMetricsRegistry({});

    registry.recordRngCursors({ 'spawn-value': 7 });
    registry.recordRngCursors({ 'spawn-value': 7 });
    registry.recordRngCursors({ 'spawn-value': 7 });

    const lines = familyLines(
      registry.toPrometheusText(),
      METRIC_NAMES.rngDrawsTotal,
    );

    expect(lines[0].trim().endsWith('7')).toBe(true);
  });

  it('labels each substream separately', () => {
    const registry = createMetricsRegistry({});

    registry.recordRngCursors({ 'spawn-value': 3, 'relic-draw': 5 });

    const text = registry.toPrometheusText();

    expect(text).toContain(`${METRIC_LABELS.stream}="spawn-value"`);
    expect(text).toContain(`${METRIC_LABELS.stream}="relic-draw"`);
  });

  it('rejects a non-object without resolving', () => {
    const registry = createMetricsRegistry({});
    const resolutions = countResolutions(registry, 'counterSeries');

    registry.recordRngCursors(null as unknown as Record<string, number>);

    expect(resolutions()).toBe(0);
  });
});

describe('the dynamic caches are bounded', () => {
  it('keeps recording past the retention ceiling', () => {
    const registry = createMetricsRegistry({});

    // Well past MAX_SERIES_PER_FAMILY (256): the family itself refuses new
    // series beyond its ceiling, and the cache must not be what breaks first.
    for (let index = 0; index < 400; index += 1) {
      registry.recordSpanDuration(`span.${index}`, 1);
    }

    const snapshot = registry.snapshot();

    expect(snapshot).toBeDefined();
    // The family stopped at its own ceiling and reported the rest.
    expect(snapshot.rejected).toBeGreaterThan(0);
  });

  it('does not grow without limit', () => {
    const registry = createMetricsRegistry({});

    for (let index = 0; index < 400; index += 1) {
      registry.recordHealthCheck(`check.${index}`, true);
    }

    const lines = familyLines(
      registry.toPrometheusText(),
      METRIC_NAMES.healthCheckStatus,
    );

    expect(lines.length).toBeLessThanOrEqual(256);
  });

  it('still serves a recorded identifier after the ceiling is reached', () => {
    const registry = createMetricsRegistry({});

    registry.recordSpanDuration('engine.turn', 1);

    for (let index = 0; index < 400; index += 1) {
      registry.recordSpanDuration(`span.${index}`, 1);
    }

    registry.recordSpanDuration('engine.turn', 1);

    const counts = familyLines(
      registry.toPrometheusText(),
      `${METRIC_NAMES.spanDurationMilliseconds}_count`,
    ).filter((line) => line.includes('"engine.turn"'));

    expect(counts).toHaveLength(1);
    expect(counts[0]).toContain('2');
  });

  it('exports valid text after the ceiling is reached', () => {
    const registry = createMetricsRegistry({});

    for (let index = 0; index < 300; index += 1) {
      registry.recordRngCursors({ [`stream.${index}`]: index + 1 });
    }

    const text = registry.toPrometheusText();

    expect(text).toContain(METRIC_NAMES.rngDrawsTotal);
    expect(text.endsWith('\n')).toBe(true);
  });
});
