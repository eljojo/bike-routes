import { describe, it, expect } from 'vitest';
import { resampleByDistance, isOverlapping } from './spatial-dedup.mjs';

describe('resampleByDistance', () => {
  it('resamples a line at regular intervals', () => {
    // ~111m per 0.001 degree of latitude
    const points = [[45.400, -75.600], [45.410, -75.600]]; // ~1.1km apart
    const sampled = resampleByDistance(points, 200); // every 200m
    expect(sampled.length).toBeGreaterThanOrEqual(5); // ~1100m / 200m = ~5-6 points
    expect(Math.abs(sampled[0][0] - 45.400)).toBeLessThan(0.001);
    expect(Math.abs(sampled[sampled.length - 1][0] - 45.410)).toBeLessThan(0.001);
  });
});

describe('isOverlapping', () => {
  it('returns true when candidate runs along existing path', () => {
    const candidate = [[45.430, -75.660], [45.435, -75.655]];
    const existing = [[45.4301, -75.6599], [45.4351, -75.6549]];
    expect(isOverlapping(candidate, existing, 30, 0.5)).toBe(true);
  });

  it('returns false when paths are far apart', () => {
    const candidate = [[45.430, -75.660], [45.435, -75.655]];
    const existing = [[45.500, -75.500], [45.505, -75.495]];
    expect(isOverlapping(candidate, existing, 30, 0.5)).toBe(false);
  });

  it('returns true when existing path covers candidate (reverse direction)', () => {
    const candidate = [[45.432, -75.658], [45.433, -75.657]];
    const existing = [[45.430, -75.660], [45.440, -75.650]];
    expect(isOverlapping(candidate, existing, 30, 0.5)).toBe(true);
  });

  it('returns true when short existing path is fully covered by candidate', () => {
    const candidate = [[45.430, -75.660], [45.440, -75.650]];
    const existing = [[45.430, -75.660], [45.431, -75.659]]; // very short
    // existing-covers-candidate direction: few points match → < 50%
    // candidate-covers-existing direction: most of existing matches → true
    expect(isOverlapping(candidate, existing, 30, 0.5)).toBe(true);
  });
});
