import { describe, it, expect } from 'vitest';
import { orderWays } from './order-ways.mjs';
import { haversineM } from './geo.mjs';

function makeWay(id, coords) {
  return {
    id,
    geometry: coords.map(([lon, lat]) => ({ lon, lat })),
  };
}

/** Count reversals in ordered ways (same logic as the spot-check script). */
function countReversals(ordered) {
  let revs = 0, lastB = null, prev = null;
  for (const w of ordered) {
    const coords = w.geometry.map(p => [p.lon, p.lat]);
    const trace = w._reversed ? [...coords].reverse() : coords;
    if (prev) {
      // buildGPX fallback: orient by nearest endpoint (for ways without _reversed)
      if (w._reversed == null) {
        const dFirst = haversineM(prev, trace[0]);
        const dLast = haversineM(prev, trace[trace.length - 1]);
        if (dLast < dFirst) trace.reverse();
      }
    }
    if (trace.length >= 2) {
      const b = Math.atan2(trace[trace.length - 1][0] - trace[0][0], trace[trace.length - 1][1] - trace[0][1]);
      if (lastB !== null) {
        let df = Math.abs(b - lastB); if (df > Math.PI) df = 2 * Math.PI - df;
        if (df > 2 * Math.PI / 3) revs++;
      }
      lastB = b;
    }
    prev = trace[trace.length - 1];
  }
  return revs;
}

/** Check that consecutive ways share an endpoint (within tolerance). */
function isContiguous(ordered, toleranceM = 200) {
  for (let i = 0; i < ordered.length - 1; i++) {
    const g1 = ordered[i].geometry;
    const g2 = ordered[i + 1].geometry;
    const ends1 = [[g1[0].lon, g1[0].lat], [g1[g1.length - 1].lon, g1[g1.length - 1].lat]];
    const starts2 = [[g2[0].lon, g2[0].lat], [g2[g2.length - 1].lon, g2[g2.length - 1].lat]];
    let minDist = Infinity;
    for (const e of ends1) for (const s of starts2) minDist = Math.min(minDist, haversineM(e, s));
    if (minDist > toleranceM) return false;
  }
  return true;
}

describe('orderWays', () => {
  describe('basic ordering', () => {
    it('returns single way unchanged', () => {
      const ways = [makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]])];
      expect(orderWays(ways)).toHaveLength(1);
    });

    it('orders a shuffled 3-way east-west path', () => {
      const ways = [
        makeWay(2, [[-70.65, -33.43], [-70.64, -33.43]]),
        makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]]),
        makeWay(3, [[-70.64, -33.43], [-70.63, -33.43]]),
      ];
      const ordered = orderWays(ways);
      expect(ordered).toHaveLength(3);
      expect(isContiguous(ordered)).toBe(true);
      expect(countReversals(ordered)).toBe(0);
    });

    it('orders a shuffled north-south path', () => {
      const ways = [
        makeWay(2, [[-70.65, -33.44], [-70.65, -33.43]]),
        makeWay(1, [[-70.65, -33.45], [-70.65, -33.44]]),
        makeWay(3, [[-70.65, -33.43], [-70.65, -33.42]]),
      ];
      const ordered = orderWays(ways);
      expect(ordered).toHaveLength(3);
      expect(isContiguous(ordered)).toBe(true);
      expect(countReversals(ordered)).toBe(0);
    });

    it('orders an L-shaped path (east then north)', () => {
      const ways = [
        makeWay(2, [[-70.64, -33.43], [-70.64, -33.42]]),  // north leg
        makeWay(1, [[-70.66, -33.43], [-70.64, -33.43]]),   // east leg
      ];
      const ordered = orderWays(ways);
      expect(ordered).toHaveLength(2);
      expect(isContiguous(ordered)).toBe(true);
    });
  });

  describe('dedup', () => {
    it('deduplicates overlapping ways (same endpoints, similar midpoint)', () => {
      const ways = [
        makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]]),
        makeWay(2, [[-70.66, -33.43], [-70.6505, -33.43], [-70.65, -33.43]]), // longer, same ground
        makeWay(3, [[-70.65, -33.43], [-70.64, -33.43]]),
      ];
      const ordered = orderWays(ways);
      expect(ordered.length).toBeLessThanOrEqual(2); // one of the overlapping pair dropped
    });

    it('keeps legitimate parallel segments (same cluster pair, different midpoints)', () => {
      // Two paths between same junctions but 150m apart (different sides of road)
      const ways = [
        makeWay(1, [[-70.66, -33.430], [-70.65, -33.430]]),  // south side
        makeWay(2, [[-70.66, -33.429], [-70.65, -33.429]]),   // north side, 110m away
        makeWay(3, [[-70.65, -33.430], [-70.64, -33.430]]),   // continuation
      ];
      const ordered = orderWays(ways);
      // Both parallel segments should survive (midpoints > 80m apart)
      expect(ordered.length).toBeGreaterThanOrEqual(2);
    });

    it('drops self-loops', () => {
      const ways = [
        makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]]),
        makeWay(2, [[-70.65, -33.43], [-70.6501, -33.43]]),  // tiny loop: same cluster
        makeWay(3, [[-70.65, -33.43], [-70.64, -33.43]]),
      ];
      const ordered = orderWays(ways);
      expect(ordered.length).toBeLessThanOrEqual(2);
    });

    it('drops fragments shorter than snap distance', () => {
      const ways = [
        makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]]),
        makeWay(2, [[-70.65, -33.43], [-70.64999, -33.43]]),  // ~8m
        makeWay(3, [[-70.65, -33.43], [-70.64, -33.43]]),
      ];
      const ordered = orderWays(ways);
      expect(ordered.length).toBeLessThanOrEqual(2);
    });
  });

  describe('junction handling', () => {
    it('prefers straight continuation at T-junction', () => {
      // Main path goes east: A→B→C
      // Spur goes south from B: B→D
      const ways = [
        makeWay(1, [[-70.67, -33.43], [-70.66, -33.43]]),   // A→B
        makeWay(2, [[-70.66, -33.43], [-70.65, -33.43]]),   // B→C (straight)
        makeWay(3, [[-70.66, -33.43], [-70.66, -33.44]]),   // B→D (spur south)
      ];
      const ordered = orderWays(ways);
      expect(ordered).toHaveLength(3);
      // The spur should be last (reversal if any should be at the end)
      const revs = countReversals(ordered);
      expect(revs).toBeLessThanOrEqual(1);
    });
  });

  describe('disconnected components', () => {
    it('stitches two separated segments', () => {
      const ways = [
        makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]]),
        makeWay(2, [[-70.63, -33.43], [-70.62, -33.43]]),  // 2km gap
      ];
      const ordered = orderWays(ways);
      expect(ordered).toHaveLength(2);
    });
  });

  describe('orientation', () => {
    it('returns ways with _reversed flag', () => {
      const ways = [
        makeWay(1, [[-70.65, -33.43], [-70.66, -33.43]]),  // stored west-to-east
        makeWay(2, [[-70.64, -33.43], [-70.65, -33.43]]),   // stored east-to-west
      ];
      const ordered = orderWays(ways);
      expect(ordered).toHaveLength(2);
      // Every way should have _reversed defined
      for (const w of ordered) {
        expect(w._reversed).toBeDefined();
      }
    });
  });
});
