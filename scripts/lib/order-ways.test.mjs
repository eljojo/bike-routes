import { describe, it, expect } from 'vitest';
import { orderWays } from './order-ways.mjs';
import { haversineM } from './geo.mjs';

function makeWay(id, coords) {
  return {
    id,
    geometry: coords.map(([lon, lat]) => ({ lon, lat })),
  };
}

/** Count reversals (bearing change > 120°) in the trace as buildGPX would render it. */
function countReversals(ordered) {
  let revs = 0, lastB = null, prev = null;
  for (const w of ordered) {
    const coords = w.geometry.map(p => [p.lon, p.lat]);
    let trace = w._reversed ? [...coords].reverse() : coords;
    if (prev && w._reversed == null) {
      const dFirst = haversineM(prev, trace[0]);
      const dLast = haversineM(prev, trace[trace.length - 1]);
      if (dLast < dFirst) trace = [...trace].reverse();
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

describe('orderWays', () => {
  it('orders a simple 3-way path without reversals', () => {
    const ways = [
      makeWay(2, [[-70.65, -33.43], [-70.64, -33.43]]),
      makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]]),
      makeWay(3, [[-70.64, -33.43], [-70.63, -33.43]]),
    ];
    const ordered = orderWays(ways);
    expect(ordered).toHaveLength(3);
    expect(countReversals(ordered)).toBe(0);
  });

  it('orders a north-south path without reversals', () => {
    const ways = [
      makeWay(2, [[-70.65, -33.44], [-70.65, -33.43]]),
      makeWay(1, [[-70.65, -33.45], [-70.65, -33.44]]),
      makeWay(3, [[-70.65, -33.43], [-70.65, -33.42]]),
    ];
    expect(countReversals(orderWays(ways))).toBe(0);
  });

  it('orders a diagonal path without reversals', () => {
    const ways = [];
    for (let i = 0; i < 6; i++) {
      ways.push(makeWay(i, [
        [-70.70 + i * 0.008, -33.45 + i * 0.005],
        [-70.70 + (i + 1) * 0.008, -33.45 + (i + 1) * 0.005],
      ]));
    }
    ways.sort(() => Math.random() - 0.5);
    expect(countReversals(orderWays(ways))).toBe(0);
  });

  it('orders a curved quarter-circle path without reversals', () => {
    const ways = [];
    const cx = -70.65, cy = -33.43, r = 0.03;
    for (let i = 0; i < 8; i++) {
      const a1 = (i / 8) * Math.PI / 2;
      const a2 = ((i + 1) / 8) * Math.PI / 2;
      ways.push(makeWay(i, [
        [cx + r * Math.cos(a1), cy + r * Math.sin(a1)],
        [cx + r * Math.cos(a2), cy + r * Math.sin(a2)],
      ]));
    }
    ways.sort(() => Math.random() - 0.5);
    expect(countReversals(orderWays(ways))).toBe(0);
  });

  it('handles reversed OSM way directions without reversals', () => {
    // All stored east-to-west but should form a continuous corridor
    const ways = [
      makeWay(1, [[-70.64, -33.43], [-70.65, -33.43]]),
      makeWay(2, [[-70.63, -33.43], [-70.64, -33.43]]),
      makeWay(3, [[-70.66, -33.43], [-70.67, -33.43]]),
      makeWay(4, [[-70.65, -33.43], [-70.66, -33.43]]),
    ];
    expect(countReversals(orderWays(ways))).toBe(0);
  });

  // ---------------------------------------------------------------
  // Mapocho-like spur problem
  //
  // Reproduces the actual Mapocho 42k bug:
  // - Main corridor: 8 segments going west→east, ~8km
  // - Eastern spur: 1 segment extending 3km further east from a
  //   junction that's NOT at the corridor's east end but near it
  //
  // The spur shares a junction with the main corridor.
  // The walk must not reverse through the main corridor to reach
  // the spur — the spur should be walked last.
  //
  // Expected: 0 reversals (spur continues the same eastward direction)
  //           OR at most 1 reversal at the very end (acceptable)
  // ---------------------------------------------------------------
  it('handles a corridor with an eastern spur (Mapocho pattern)', () => {
    const ways = [];
    // Main corridor: 8 segments west→east
    // -70.76 to -70.60, each ~2km
    for (let i = 0; i < 8; i++) {
      const lng1 = -70.76 + i * 0.02;
      const lng2 = lng1 + 0.02;
      ways.push(makeWay(i + 1, [[lng1, -33.42], [lng2, -33.42]]));
    }
    // Junction is at -70.60 (east end of main corridor)
    // Spur extends further east from -70.60 to -70.57 (3km)
    ways.push(makeWay(9, [[-70.60, -33.42], [-70.57, -33.41]]));

    // Shuffle to simulate unordered OSM data
    ways.sort(() => Math.random() - 0.5);

    const ordered = orderWays(ways);
    expect(ordered).toHaveLength(9);
    expect(countReversals(ordered)).toBeLessThanOrEqual(1);
  });

  // Same as above but spur branches from the MIDDLE of the corridor,
  // not the end. This is harder — the walk must go through the
  // corridor in one direction, then backtrack to pick up the spur.
  it('handles a corridor with a mid-point spur', () => {
    const ways = [];
    // Main corridor: 6 segments west→east
    for (let i = 0; i < 6; i++) {
      const lng1 = -70.70 + i * 0.02;
      const lng2 = lng1 + 0.02;
      ways.push(makeWay(i + 1, [[lng1, -33.42], [lng2, -33.42]]));
    }
    // Spur from midpoint (-70.64) going south
    ways.push(makeWay(7, [[-70.64, -33.42], [-70.64, -33.44]]));

    ways.sort(() => Math.random() - 0.5);

    const ordered = orderWays(ways);
    expect(ordered).toHaveLength(7);
    expect(countReversals(ordered)).toBeLessThanOrEqual(1);
  });

  // Duplicate ways covering the same ground — like Mapocho where
  // OSM relation has overlapping sections
  it('deduplicates overlapping ways in the same corridor', () => {
    const ways = [];
    // 4 segments west→east
    for (let i = 0; i < 4; i++) {
      const lng1 = -70.70 + i * 0.02;
      const lng2 = lng1 + 0.02;
      ways.push(makeWay(i + 1, [[lng1, -33.42], [lng2, -33.42]]));
    }
    // Duplicate of segments 1-2 (same endpoints, slightly different midpoint)
    ways.push(makeWay(5, [[-70.70, -33.42], [-70.68, -33.4201]]));
    ways.push(makeWay(6, [[-70.68, -33.42], [-70.66, -33.4201]]));

    ways.sort(() => Math.random() - 0.5);

    const ordered = orderWays(ways);
    // Should dedup the duplicates and produce a clean trace
    expect(ordered.length).toBeLessThanOrEqual(4);
    expect(countReversals(ordered)).toBe(0);
  });

  // Y-junction: stem + two branches
  it('handles a Y-junction with at most 1 reversal', () => {
    const ways = [
      makeWay(1, [[-70.68, -33.43], [-70.67, -33.43]]),   // stem
      makeWay(2, [[-70.67, -33.43], [-70.66, -33.42]]),   // NE branch
      makeWay(3, [[-70.67, -33.43], [-70.66, -33.44]]),   // SE branch
    ];
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    expect(ordered).toHaveLength(3);
    expect(countReversals(ordered)).toBeLessThanOrEqual(1);
  });

  // Reproduces the exact Mapocho topology: main corridor + spur +
  // duplicate section covering 4 ways in the middle.
  // The duplicate ways have SLIGHTLY different endpoints (within 30m)
  // simulating how OSM has multiple overlapping ways for the same road.
  it('handles Mapocho-like corridor with duplicates AND spur', () => {
    const ways = [];
    // Main corridor: 10 segments west→east (-70.76 to -70.60)
    for (let i = 0; i < 10; i++) {
      const lng1 = -70.76 + i * 0.016;
      const lng2 = lng1 + 0.016;
      ways.push(makeWay(100 + i, [[lng1, -33.420], [lng2, -33.420]]));
    }
    // Spur extending east from junction at -70.60
    ways.push(makeWay(200, [[-70.600, -33.420], [-70.570, -33.415]]));

    // Duplicate ways covering segments 5-8 (middle-east section)
    // with ~100m offset — outside snap distance, simulating OSM data
    // where the same corridor is mapped as separate parallel ways
    for (let i = 5; i < 9; i++) {
      const lng1 = -70.76 + i * 0.016 + 0.0005; // ~40m lng offset
      const lng2 = lng1 + 0.016;
      ways.push(makeWay(300 + i, [[lng1, -33.4210], [lng2, -33.4210]])); // ~110m south
    }

    ways.sort(() => Math.random() - 0.5);

    const ordered = orderWays(ways);
    // Should dedup the 4 duplicates, keep 10 main + 1 spur = 11
    // (or fewer if dedup catches more)
    // When dedup works: ≤11 ways, 0-1 reversals
    // Current bug: 15 ways (duplicates not caught), multiple reversals
    expect(ordered.length).toBeLessThanOrEqual(11);
    expect(countReversals(ordered)).toBeLessThanOrEqual(1);
  });

  // Returns _reversed flag on all ways
  it('returns _reversed flag on all ways', () => {
    const ways = [
      makeWay(1, [[-70.66, -33.43], [-70.65, -33.43]]),
      makeWay(2, [[-70.65, -33.43], [-70.64, -33.43]]),
    ];
    const ordered = orderWays(ways);
    for (const w of ordered) {
      expect(w._reversed).toBeDefined();
    }
  });
});
