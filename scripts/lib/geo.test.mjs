import { describe, it, expect } from 'vitest';
import { nearestPointOnPolyline } from './geo.mjs';

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
