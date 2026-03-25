import { describe, it, expect } from 'vitest';
import { haversineM } from './geo.mjs';
import { chainBikePaths } from './chain-bike-paths.mjs';

function makeWay(id, coords) {
  return { id, geometry: coords.map(([lon, lat]) => ({ lon, lat })) };
}

function makeLinearPath(startLng, endLng, lat, n) {
  const ways = [];
  const step = (endLng - startLng) / n;
  for (let i = 0; i < n; i++) {
    ways.push(makeWay(i, [
      [startLng + i * step, lat],
      [startLng + (i + 1) * step, lat],
    ]));
  }
  return ways;
}

function makeNSPath(lng, startLat, endLat, n) {
  const ways = [];
  const step = (endLat - startLat) / n;
  for (let i = 0; i < n; i++) {
    ways.push(makeWay(i, [
      [lng, startLat + i * step],
      [lng, startLat + (i + 1) * step],
    ]));
  }
  return ways;
}

/** Render ways into a coordinate trace the way buildGPX would. */
function renderTrace(ways) {
  const pts = [];
  let prev = null;
  for (const w of ways) {
    const coords = w.geometry.map(p => [p.lon, p.lat]);
    let trace = w._reversed ? [...coords].reverse() : coords;
    if (prev && w._reversed == null) {
      if (haversineM(prev, trace[trace.length - 1]) < haversineM(prev, trace[0]))
        trace = [...trace].reverse();
    }
    for (const c of trace) pts.push(c);
    prev = trace[trace.length - 1];
  }
  return pts;
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

function totalDistance(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1], pts[i]);
  return d;
}

describe('chainBikePaths', () => {
  // ---------------------------------------------------------------
  // Lastarria → Ñuñoa: the reference route
  //
  // Waypoints: Parque Forestal → Costanera Sur (east) → Sánchez Fontecilla (south) → Plaza Ñuñoa
  //
  // Costanera Sur is a 10km east-west path along the river.
  // Sánchez Fontecilla is a 4km north-south path.
  // They intersect near -70.575, -33.43.
  //
  // The route should ONLY use:
  //   - Costanera Sur from Parque Forestal (-70.64) EAST to the junction (-70.575)
  //   - Sánchez Fontecilla from the junction SOUTH to Plaza Ñuñoa (-33.46)
  //
  // It should NOT ride all 10km of Costanera Sur — just the ~5.5km
  // from Forestal to the junction.
  // ---------------------------------------------------------------
  it('Lastarria→Ñuñoa: uses only the relevant section of each bike path', () => {
    // Costanera Sur: 10km east-west path (-70.69 to -70.55)
    const costanera = makeLinearPath(-70.69, -70.55, -33.425, 8);

    // Sánchez Fontecilla: 4km north-south path, intersects Costanera near -70.575
    const sanchez = makeNSPath(-70.575, -33.425, -33.465, 5);

    // Start point: Parque Forestal at -70.64 (on Costanera, ~4km from west end)
    // End point: Plaza Ñuñoa at -33.46 (on Sánchez Fontecilla, near south end)
    const startPoint = [-70.64, -33.425];
    const endPoint = [-70.575, -33.46];

    // Chain: the system gets [costanera, sanchez] as waypoints.
    // It should figure out to ride Costanera EAST from -70.64 to -70.575,
    // then Sánchez Fontecilla SOUTH from -33.425 to -33.46.
    const chained = chainBikePaths([costanera, sanchez]);
    const pts = renderTrace(chained);

    // The ride should be ~5.5km (Costanera section) + ~4km (Sánchez) ≈ 9.5km
    // NOT 10km + 4km = 14km (full paths)
    // And definitely not 20km+ (full paths with backtracking)
    const dist = totalDistance(pts);
    expect(dist).toBeLessThan(12000); // not inflated
    expect(dist).toBeGreaterThan(7000); // covers the actual ride

    expect(maxJump(pts)).toBeLessThan(1500); // no huge gaps
    expect(countReversals(pts)).toBe(0); // no backtracking
  });

  // ---------------------------------------------------------------
  // Las Perdices: two end-to-end north-south paths
  // ---------------------------------------------------------------
  it('Las Perdices: two consecutive paths without reversals', () => {
    // Path 1: -33.44 to -33.46 (north to south)
    const path1 = makeNSPath(-70.533, -33.44, -33.461, 3);
    // Path 2: -33.461 to -33.51 (continuing south)
    const path2 = makeNSPath(-70.534, -33.461, -33.51, 5);

    const chained = chainBikePaths([path1, path2]);
    const pts = renderTrace(chained);

    expect(maxJump(pts)).toBeLessThan(1500);
    expect(countReversals(pts)).toBe(0);

    // Should cover full extent: ~2.3km + ~5.4km ≈ 7.7km
    const dist = totalDistance(pts);
    expect(dist).toBeGreaterThan(5000);
    expect(dist).toBeLessThan(12000);
  });

  // ---------------------------------------------------------------
  // Gran Mapocho: three overlapping east-west river paths
  // ---------------------------------------------------------------
  it('Gran Mapocho: overlapping river paths produce a single clean corridor', () => {
    // Mapocho 42k: full corridor (-70.76 to -70.57)
    const mapocho = makeLinearPath(-70.76, -70.57, -33.42, 10);
    // Andrés Bello: short middle section (-70.63 to -70.61)
    const andresBello = makeLinearPath(-70.63, -70.61, -33.421, 3);
    // Costanera Sur: east-middle section (-70.69 to -70.60)
    const costanera = makeLinearPath(-70.69, -70.60, -33.419, 5);

    const chained = chainBikePaths([mapocho, andresBello, costanera]);
    const pts = renderTrace(chained);

    expect(maxJump(pts)).toBeLessThan(1000);
    expect(countReversals(pts)).toBe(0);
  });
});
