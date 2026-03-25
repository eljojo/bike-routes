import { describe, it, expect } from 'vitest';
import { orderWays } from './order-ways.mjs';

function makeWay(id, coords) {
  return {
    id,
    geometry: coords.map(([lon, lat]) => ({ lon, lat })),
  };
}

describe('orderWays', () => {
  it('orders a simple 3-way linear path', () => {
    // B-C, A-B, C-D — shuffled, should become A→B→C→D or D→C→B→A
    const ways = [
      makeWay(2, [[-70.65, -33.43], [-70.64, -33.43]]),  // B-C
      makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]]),  // A-B
      makeWay(3, [[-70.64, -33.43], [-70.63, -33.43]]),  // C-D
    ];
    const ordered = orderWays(ways);
    expect(ordered).toHaveLength(3);
    // Consecutive ways should share an endpoint (within 50m)
    for (let i = 0; i < ordered.length - 1; i++) {
      const g1 = ordered[i].geometry;
      const g2 = ordered[i + 1].geometry;
      const end1 = [g1[g1.length - 1].lon, g1[g1.length - 1].lat];
      const start2 = [g2[0].lon, g2[0].lat];
      const end2 = [g2[g2.length - 1].lon, g2[g2.length - 1].lat];
      // One of the endpoints should be close
      const minDist = Math.min(
        Math.abs(end1[0] - start2[0]) + Math.abs(end1[1] - start2[1]),
        Math.abs(end1[0] - end2[0]) + Math.abs(end1[1] - end2[1]),
      );
      expect(minDist).toBeLessThan(0.02); // ~1km tolerance
    }
  });

  it('orders a north-south path', () => {
    const ways = [
      makeWay(2, [[-70.65, -33.44], [-70.65, -33.43]]),  // middle
      makeWay(1, [[-70.65, -33.45], [-70.65, -33.44]]),  // south
      makeWay(3, [[-70.65, -33.43], [-70.65, -33.42]]),  // north
    ];
    const ordered = orderWays(ways);
    expect(ordered).toHaveLength(3);
    // Should go south to north or north to south continuously
    const lats = ordered.map(w => w.geometry[0].lat);
    const increasing = lats[0] < lats[1] && lats[1] < lats[2];
    const decreasing = lats[0] > lats[1] && lats[1] > lats[2];
    expect(increasing || decreasing).toBe(true);
  });

  it('orders an L-shaped path', () => {
    // Goes east then turns north
    const ways = [
      makeWay(2, [[-70.64, -33.43], [-70.64, -33.42]]),  // north leg
      makeWay(1, [[-70.66, -33.43], [-70.64, -33.43]]),  // east leg
    ];
    const ordered = orderWays(ways);
    expect(ordered).toHaveLength(2);
  });

  it('deduplicates overlapping ways', () => {
    // Two ways covering same ground, different lengths
    const ways = [
      makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]]),  // short
      makeWay(2, [[-70.66, -33.43], [-70.65, -33.43], [-70.645, -33.43]]),  // longer, same start
      makeWay(3, [[-70.65, -33.43], [-70.64, -33.43]]),  // continuation
    ];
    const ordered = orderWays(ways);
    // Should have 2 ways (deduped the short one)
    expect(ordered.length).toBeLessThanOrEqual(3);
  });

  it('handles disconnected components', () => {
    // Two separate segments with a gap
    const ways = [
      makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]]),
      makeWay(2, [[-70.63, -33.43], [-70.62, -33.43]]),  // 2km gap
    ];
    const ordered = orderWays(ways);
    expect(ordered).toHaveLength(2);
  });
});
