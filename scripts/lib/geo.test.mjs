import { describe, it, expect } from 'vitest';
import { nearestPointOnPolyline, corridorWidth } from './geo.mjs';

describe('nearestPointOnPolyline', () => {
  it('projects a point onto a straight horizontal line', () => {
    const polyline = [[-70.66, -33.42], [-70.64, -33.42], [-70.62, -33.42]];
    const result = nearestPointOnPolyline([-70.64, -33.43], polyline);
    expect(result.scalar).toBeGreaterThan(1500);
    expect(result.scalar).toBeLessThan(2000);
    expect(result.coord[0]).toBeCloseTo(-70.64, 3);
    expect(result.coord[1]).toBeCloseTo(-33.42, 3);
  });

  it('clamps to start when point is before the line', () => {
    const polyline = [[-70.64, -33.42], [-70.62, -33.42]];
    const result = nearestPointOnPolyline([-70.66, -33.42], polyline);
    expect(result.scalar).toBe(0);
  });

  it('clamps to end when point is past the line', () => {
    const polyline = [[-70.64, -33.42], [-70.62, -33.42]];
    const result = nearestPointOnPolyline([-70.60, -33.42], polyline);
    expect(result.scalar).toBeCloseTo(result.totalLength, 1);
  });

  it('works on a north-south line', () => {
    const polyline = [[-70.60, -33.45], [-70.60, -33.43], [-70.60, -33.41]];
    const result = nearestPointOnPolyline([-70.61, -33.43], polyline);
    expect(result.scalar).toBeGreaterThan(1500);
    expect(result.scalar).toBeLessThan(3000);
  });

  it('returns totalLength field', () => {
    const polyline = [[-70.64, -33.42], [-70.62, -33.42]];
    const result = nearestPointOnPolyline([-70.63, -33.42], polyline);
    expect(result.totalLength).toBeGreaterThan(1500);
    expect(result.totalLength).toBeLessThan(2000);
  });
});

describe('corridorWidth', () => {
  it('returns 0 for a single point', () => {
    expect(corridorWidth([[-75.9, 45.3]])).toBe(0);
  });

  it('returns 0 for collinear points (pure line)', () => {
    const points = [[-75.9, 45.30], [-75.9, 45.31], [-75.9, 45.32]];
    expect(corridorWidth(points)).toBeLessThan(1);
  });

  it('returns small width for a narrow corridor', () => {
    const points = [
      [-75.82, 45.29], [-75.82, 45.30], [-75.82, 45.31],
      [-75.8205, 45.295], [-75.8195, 45.305],
    ];
    const w = corridorWidth(points);
    expect(w).toBeLessThan(500);
    expect(w).toBeGreaterThan(50);
  });

  it('returns large width for a spread-out cluster', () => {
    const points = [
      [-75.82, 45.29], [-75.82, 45.31],
      [-75.80, 45.29], [-75.80, 45.31],
    ];
    const w = corridorWidth(points);
    expect(w).toBeGreaterThan(1500);
  });
});
