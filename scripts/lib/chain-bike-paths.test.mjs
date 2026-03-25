import { describe, it, expect } from 'vitest';
import { haversineM } from './geo.mjs';
import { chainBikePaths } from './chain-bike-paths.mjs';

/**
 * Test for combined route generation — chaining multiple bike paths
 * into one continuous trace.
 *
 * The Gran Mapocho problem: three bike paths run along the same river
 * corridor but cover different (overlapping) sections:
 *
 *   Mapocho 42k:    |============================|  (-70.76 to -70.57)
 *   Andrés Bello:              |=====|              (-70.63 to -70.61)
 *   Costanera Sur:        |============|            (-70.69 to -70.60)
 *
 * The combined route should follow the river continuously:
 *   Start at -70.76, go east, end at -70.57.
 *   NOT: dump all of path 1, then all of path 2, then all of path 3
 *   (which creates 20km straight-line gaps between endpoints).
 *
 * The expected trace should:
 *   1. Have no jumps > 1km (no straight-line gaps)
 *   2. Have 0 reversals
 *   3. Cover the full extent of the corridor
 */

function makeWay(id, coords) {
  return {
    id,
    geometry: coords.map(([lon, lat]) => ({ lon, lat })),
  };
}

function makeLinearBikePath(startLng, endLng, lat, segCount) {
  const ways = [];
  const step = (endLng - startLng) / segCount;
  for (let i = 0; i < segCount; i++) {
    const lng1 = startLng + i * step;
    const lng2 = lng1 + step;
    ways.push(makeWay(i, [[lng1, lat], [lng2, lat]]));
  }
  return ways;
}

function countReversals(pts) {
  let revs = 0, lastB = null, prev = null;
  for (const p of pts) {
    if (prev) {
      const b = Math.atan2(p[0] - prev[0], p[1] - prev[1]);
      if (lastB !== null) {
        let df = Math.abs(b - lastB); if (df > Math.PI) df = 2 * Math.PI - df;
        if (df > 2 * Math.PI / 3) revs++;
      }
      lastB = b;
    }
    prev = p;
  }
  return revs;
}

function maxJump(pts) {
  let max = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = haversineM(pts[i - 1], pts[i]);
    if (d > max) max = d;
  }
  return max;
}

describe('chaining bike paths', () => {
  it('should chain two perpendicular paths at a junction (La Reina pattern)', () => {
    // Path 1 goes north-south: -33.46 to -33.43 (northward)
    // Path 2 goes east-west: -70.60 to -70.68 (westward)
    // They share a junction near -33.43, -70.60
    //
    // The combined route should go: south→north on path 1,
    // then east→west on path 2. No reversals.
    // The turn at the junction is ~90°, not a reversal.

    const path1 = [];
    for (let i = 0; i < 4; i++) {
      path1.push(makeWay(100 + i, [
        [-70.555, -33.46 + i * 0.008],
        [-70.555, -33.46 + (i + 1) * 0.008],
      ]));
    }
    // Path 1 ends at -33.428

    const path2 = [];
    for (let i = 0; i < 6; i++) {
      path2.push(makeWay(200 + i, [
        [-70.56 - i * 0.02, -33.425],
        [-70.56 - (i + 1) * 0.02, -33.425],
      ]));
    }
    // Path 2 goes from -70.56 to -70.68

    const chained = chainBikePaths([path1, path2]);
    const chainedPts = [];
    for (const w of chained) {
      const coords = w.geometry.map(p => [p.lon, p.lat]);
      if (chainedPts.length > 0) {
        const prev = chainedPts[chainedPts.length - 1];
        const dFirst = haversineM(prev, coords[0]);
        const dLast = haversineM(prev, coords[coords.length - 1]);
        if (dLast < dFirst) coords.reverse();
      }
      for (const c of coords) chainedPts.push(c);
    }

    // Should be ~3.2km (path1) + ~10km (path2) ≈ 13km, not 2x that
    let totalDist = 0;
    for (let i = 1; i < chainedPts.length; i++) totalDist += haversineM(chainedPts[i-1], chainedPts[i]);
    expect(totalDist).toBeLessThan(20000); // not inflated by backtracking

    expect(maxJump(chainedPts)).toBeLessThan(2000);
    expect(countReversals(chainedPts)).toBe(0);
  });


  it('should chain two end-to-end paths without reversals (Las Perdices pattern)', () => {
    // Two north-south paths that connect at a shared junction.
    // Path 1 runs from -33.44 to -33.46 (north to south)
    // Path 2 runs from -33.46 to -33.51 (continuing south)
    // They share a junction at -33.46.
    //
    // The combined trace should go continuously north→south
    // with 0 reversals. The current bug: path 1's walk starts
    // from -33.46 going north to -33.44, then the trace jumps
    // back to -33.46 to start path 2.

    const path1 = makeLinearBikePath(-70.53, -70.53, -33.44, 3)  // 3 segments
      .map((w, i) => makeWay(100 + i, [
        [-70.533, -33.44 - i * 0.007],
        [-70.533, -33.44 - (i + 1) * 0.007],
      ]));

    const path2 = makeLinearBikePath(-70.53, -70.53, -33.46, 5)  // 5 segments
      .map((w, i) => makeWay(200 + i, [
        [-70.534, -33.461 - i * 0.01],
        [-70.534, -33.461 - (i + 1) * 0.01],
      ]));

    // Path 1 ends near -33.461, path 2 starts near -33.461
    // They should connect smoothly

    const chained = chainBikePaths([path1, path2]);
    const chainedPts = [];
    for (const w of chained) {
      const coords = w.geometry.map(p => [p.lon, p.lat]);
      // buildGPX orientation: use nearest endpoint to prev
      if (chainedPts.length > 0) {
        const prev = chainedPts[chainedPts.length - 1];
        const dFirst = haversineM(prev, coords[0]);
        const dLast = haversineM(prev, coords[coords.length - 1]);
        if (dLast < dFirst) coords.reverse();
      }
      for (const c of coords) chainedPts.push(c);
    }

    expect(maxJump(chainedPts)).toBeLessThan(1500);
    expect(countReversals(chainedPts)).toBe(0);
  });


  it('should produce a clean trace from 3 overlapping river corridor paths', () => {
    // Simulate Mapocho corridor: 3 paths along the same river
    const mapocho = makeLinearBikePath(-70.76, -70.57, -33.42, 10);     // full corridor
    const andresBello = makeLinearBikePath(-70.63, -70.61, -33.421, 3); // short middle section
    const costanera = makeLinearBikePath(-70.69, -70.60, -33.419, 5);   // east-middle section

    // This is what the combined route script currently does:
    // concatenate all ways from each path in sequence
    const naive = [...mapocho, ...andresBello, ...costanera];
    const naivePts = naive.flatMap(w => w.geometry.map(p => [p.lon, p.lat]));

    // The naive approach SHOULD fail these checks:
    // (If it doesn't, the test data doesn't reproduce the problem)
    const naiveMaxJump = maxJump(naivePts);
    const naiveReversals = countReversals(naivePts);

    // With overlapping paths naively concatenated, there will be a big
    // jump from mapocho's east end (-70.57) back to andresBello's start (-70.63)
    // That's ~5km jump. Then from andresBello end (-70.61) to costanera start (-70.69)
    // is another ~7km jump.
    expect(naiveMaxJump).toBeGreaterThan(3000); // confirms the problem exists

    // chainBikePaths should produce a clean trace
    const chained = chainBikePaths([mapocho, andresBello, costanera]);
    const chainedPts = [];
    for (const w of chained) {
      const coords = w.geometry.map(p => [p.lon, p.lat]);
      const trace = w._reversed ? [...coords].reverse() : coords;
      for (const c of trace) chainedPts.push(c);
    }

    expect(maxJump(chainedPts)).toBeLessThan(1000);
    expect(countReversals(chainedPts)).toBe(0);
  });
});
