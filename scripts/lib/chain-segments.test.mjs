import { describe, it, expect } from 'vitest';
import { chainSegments } from './chain-segments.mjs';

// Ottawa roughly: lat ~45.4, lon ~-75.7
// 1 degree lat ≈ 111km, 1 degree lon ≈ ~78km at 45°
// 50m in lat ≈ 0.00045°, 50m in lon ≈ ~0.00064°

describe('chainSegments', () => {
  it('chains two segments with centers within 50m', () => {
    const segments = [
      { id: 1, center: { lat: 45.4000, lon: -75.7000 }, tags: { name: 'Seg A' } },
      { id: 2, center: { lat: 45.4002, lon: -75.7002 }, tags: { name: 'Seg B' } },
      // ~25m apart — should chain
    ];
    const chains = chainSegments(segments, 50);
    expect(chains).toHaveLength(1);
    expect(chains[0].segmentIds).toContain(1);
    expect(chains[0].segmentIds).toContain(2);
  });

  it('keeps far-apart segments as separate chains', () => {
    const segments = [
      { id: 10, center: { lat: 45.4000, lon: -75.7000 }, tags: { name: 'Far A' } },
      { id: 11, center: { lat: 45.4200, lon: -75.7200 }, tags: { name: 'Far B' } },
      // ~2.5km apart — should NOT chain
    ];
    const chains = chainSegments(segments, 50);
    expect(chains).toHaveLength(2);
  });

  it('chains three segments in a line', () => {
    // Each consecutive pair is ~22m apart; first and last ~44m apart — all chain
    const segments = [
      { id: 1, center: { lat: 45.40000, lon: -75.70000 }, tags: {} },
      { id: 2, center: { lat: 45.40010, lon: -75.70010 }, tags: {} },
      { id: 3, center: { lat: 45.40020, lon: -75.70020 }, tags: {} },
    ];
    const chains = chainSegments(segments, 50);
    expect(chains).toHaveLength(1);
    expect(chains[0].segmentIds).toHaveLength(3);
  });

  it('computes chain midpoint from segment centers', () => {
    const segments = [
      { id: 1, center: { lat: 45.4000, lon: -75.7000 }, tags: {} },
      { id: 2, center: { lat: 45.4002, lon: -75.7002 }, tags: {} },
    ];
    const chains = chainSegments(segments, 50);
    expect(chains).toHaveLength(1);
    expect(chains[0].midpoint.lat).toBeCloseTo(45.4001, 4);
    expect(chains[0].midpoint.lon).toBeCloseTo(-75.7001, 4);
  });

  it('computes chain bounding box', () => {
    const segments = [
      { id: 1, center: { lat: 45.4000, lon: -75.7010 }, tags: {} },
      { id: 2, center: { lat: 45.4005, lon: -75.7000 }, tags: {} },
    ];
    const chains = chainSegments(segments, 100);
    expect(chains).toHaveLength(1);
    const { bbox } = chains[0];
    expect(bbox.south).toBeCloseTo(45.4000, 4);
    expect(bbox.north).toBeCloseTo(45.4005, 4);
    expect(bbox.west).toBeCloseTo(-75.7010, 4);
    expect(bbox.east).toBeCloseTo(-75.7000, 4);
  });
});
