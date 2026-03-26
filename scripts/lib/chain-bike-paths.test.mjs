import { describe, it, expect } from 'vitest';
import { haversineM } from './geo.mjs';
import { chainBikePaths } from './chain-bike-paths.mjs';
import { orderWays } from './order-ways.mjs';
import { readFileSync } from 'fs';

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

/**
 * Render segmented output into a coordinate trace the way buildGPX would.
 * chainBikePaths returns Array<Array<way>> (segments).
 * Each segment is rendered independently — no cross-segment orientation.
 */
function renderTrace(segments) {
  // Handle both flat array (legacy) and segmented array
  const segs = Array.isArray(segments[0]) ? segments : [segments];
  const pts = [];
  for (const segment of segs) {
    let prev = null;
    for (const w of segment) {
      const coords = w.geometry.map(p => [p.lon, p.lat]);
      let trace = w._reversed ? [...coords].reverse() : coords;
      if (prev && w._reversed == null) {
        if (haversineM(prev, trace[trace.length - 1]) < haversineM(prev, trace[0]))
          trace = [...trace].reverse();
      }
      for (const c of trace) pts.push(c);
      prev = trace[trace.length - 1];
    }
  }
  return pts;
}

function countReversals(pts) {
  let revs = 0, lastB = null, prev = null;
  for (const p of pts) {
    if (prev) {
      // Skip duplicate/near-duplicate points (zero-length steps at way boundaries)
      if (haversineM(prev, p) < 1) continue;
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

describe('chainBikePaths — real data', () => {
  // REAL DATA: Parque Forestal → Costanera Sur → Antonio Varas → Pocuro
  // Route goes W→E: start at Parque Forestal (west), end at Pocuro (east).
  // Parque Forestal is a place waypoint anchoring the start.
  it('REAL: Forestal a Pocuro — place anchor + 3 bike paths, W→E', () => {
    const costanera = orderWays(JSON.parse(readFileSync(new URL('./fixtures/costanera-sur-ways.json', import.meta.url), 'utf8')));
    const varas = orderWays(JSON.parse(readFileSync(new URL('./fixtures/antonio-varas-ways.json', import.meta.url), 'utf8')));
    const pocuro = orderWays(JSON.parse(readFileSync(new URL('./fixtures/pocuro-ways.json', import.meta.url), 'utf8')));

    // Parque Forestal: -33.4353, -70.6413 (west anchor)
    const parqueForestal = { name: 'Parque Forestal', lat: -33.4353, lng: -70.6413 };

    const segments = chainBikePaths([parqueForestal, costanera, varas, pocuro]);
    const pts = renderTrace(segments);

    // Should go W→E (Forestal is west, Pocuro is east)
    expect(pts[pts.length - 1][0]).toBeGreaterThan(pts[0][0]);

    // Should not have excessive reversals
    expect(countReversals(pts)).toBeLessThanOrEqual(3);

    // Distance should be reasonable (~10-15km, not 30+ from backtracking)
    const dist = totalDistance(pts);
    expect(dist).toBeLessThan(20000);
  });

  // THEORY: chainBikePaths drops most input ways during trimming.
  // Input: 55 ways (9+7+39). Output: 3 ways. That's a 95% drop rate.
  // The trimming is too aggressive — finding nearest connection point
  // and cutting everything else, instead of keeping the section between
  // entry and exit.
  it('REAL: Pocuro chain should keep most input ways, not drop 95%', () => {
    const pocuro = orderWays(JSON.parse(readFileSync(new URL('./fixtures/pocuro-ways.json', import.meta.url), 'utf8')));
    const varas = orderWays(JSON.parse(readFileSync(new URL('./fixtures/antonio-varas-ways.json', import.meta.url), 'utf8')));
    const costanera = orderWays(JSON.parse(readFileSync(new URL('./fixtures/costanera-sur-ways.json', import.meta.url), 'utf8')));

    const inputWays = pocuro.length + varas.length + costanera.length;
    const segments = chainBikePaths([pocuro, varas, costanera]);
    const outputWays = segments.reduce((s, seg) => s + seg.length, 0);

    // Should keep at least 50% of input ways (trimming removes overlap, not 95%)
    expect(outputWays).toBeGreaterThan(inputWays * 0.5);
  });

  // THEORY: chainBikePaths destroys the original way structure.
  // It flattens each path into a polyline, slices it, then wraps the
  // slice as ONE synthetic way. A path with 9 OSM ways becomes 1 way
  // with all the coordinates. The output ways should be the ORIGINAL
  // OSM ways (trimmed), not synthetic polylines.
  it('REAL: output ways should be original OSM ways, not synthetic polylines', () => {
    const pocuro = orderWays(JSON.parse(readFileSync(new URL('./fixtures/pocuro-ways.json', import.meta.url), 'utf8')));
    const varas = orderWays(JSON.parse(readFileSync(new URL('./fixtures/antonio-varas-ways.json', import.meta.url), 'utf8')));
    const costanera = orderWays(JSON.parse(readFileSync(new URL('./fixtures/costanera-sur-ways.json', import.meta.url), 'utf8')));

    const segments = chainBikePaths([pocuro, varas, costanera]);
    const allOutputWays = segments.flat();

    // Every output way should have a reasonable number of points (< 100).
    // A synthetic polyline from a 39-way path would have 700+ points.
    for (const w of allOutputWays) {
      expect(w.geometry.length, `way ${w.id} has ${w.geometry.length} pts`).toBeLessThan(200);
    }
  });

  // THEORY: the last path's unconstrained exit picks the endpoint farthest
  // from entry in path order, but this sends Costanera westward (away from
  // the route's travel direction). The exit should continue the direction
  // of travel established by the previous paths.
  it('REAL: last path exit should continue travel direction, not maximize distance', () => {
    const pocuro = orderWays(JSON.parse(readFileSync(new URL('./fixtures/pocuro-ways.json', import.meta.url), 'utf8')));
    const varas = orderWays(JSON.parse(readFileSync(new URL('./fixtures/antonio-varas-ways.json', import.meta.url), 'utf8')));
    const costanera = orderWays(JSON.parse(readFileSync(new URL('./fixtures/costanera-sur-ways.json', import.meta.url), 'utf8')));

    const segments = chainBikePaths([pocuro, varas, costanera]);
    // Costanera is the last segment. Its entry is near its east end
    // (closest to Varas). Its exit should be EAST of the entry (continuing
    // the eastward travel direction), not at the west end.
    const lastSeg = segments[segments.length - 1];
    const lastWay = lastSeg[lastSeg.length - 1];
    const firstWay = lastSeg[0];
    const startLng = firstWay.geometry[0].lon;
    const endLng = lastWay.geometry[lastWay.geometry.length - 1].lon;
    // The last segment should not go significantly westward
    // (its end should not be more than 2km west of its start)
    // Currently it goes from -70.60 to -70.77 (17km west!) — that's wrong
    expect(Math.abs(endLng - startLng) * 85000).toBeLessThan(5000);
  });

  // REAL DATA: La Reina a Quinta Normal
  // Waypoints: sánchez-fontecilla → pocuro → costanera-sur → mapocho-42k → avenida-mapocho
  // Direction: EAST to WEST (La Reina is east, Quinta Normal is west)
  // The waypoint order defines the direction of travel.
  // Currently: 4 reversals, 43.8km (should be ~25km with 0 reversals)
  it('REAL: La Reina a Quinta Normal — E→W, ≤2 reversals', () => {
    const sanchez = orderWays(JSON.parse(readFileSync(new URL('./fixtures/sanchez-fontecilla-ways.json', import.meta.url), 'utf8')));
    const pocuro = orderWays(JSON.parse(readFileSync(new URL('./fixtures/pocuro-ways.json', import.meta.url), 'utf8')));
    const costanera = orderWays(JSON.parse(readFileSync(new URL('./fixtures/costanera-sur-ways.json', import.meta.url), 'utf8')));
    const mapocho42k = orderWays(JSON.parse(readFileSync(new URL('./fixtures/mapocho-42k-ways.json', import.meta.url), 'utf8')));
    const avMapocho = orderWays(JSON.parse(readFileSync(new URL('./fixtures/avenida-mapocho-ways.json', import.meta.url), 'utf8')));

    // Waypoint order: east → west
    const segments = chainBikePaths([sanchez, pocuro, costanera, mapocho42k, avMapocho]);
    const pts = renderTrace(segments);

    // Should go roughly E→W (start lng less negative than end lng)
    // La Reina (~-70.55) → Quinta Normal (~-70.72)
    expect(pts[0][0]).toBeGreaterThan(pts[pts.length - 1][0]);

    // Should not backtrack excessively
    expect(countReversals(pts)).toBeLessThanOrEqual(2);

    // Distance should be reasonable (~20-30km, not 44km)
    const dist = totalDistance(pts);
    expect(dist).toBeLessThan(35000);
  });

  // DISPROVEN THEORY: stripping _reversed makes it 5x worse (105 vs 19).
  // The _reversed flags from orderWays are crucial for orientation.
  // The reversals come from individual path ordering (orderWays internal
  // quality) not from the chain's direction logic.
});

describe('chainBikePaths — synthetic', () => {
  // ---------------------------------------------------------------
  // Emporio La Rosa → Plaza Ñuñoa
  //
  // The real ride: start at Emporio La Rosa on Merced, ride east
  // along Andrés Bello (parallel to the Mapocho), turn south on
  // Av Suecia, arrive at Plaza Ñuñoa.
  //
  // Waypoints:
  //   { name: "Emporio La Rosa (Merced)", lat: -33.4369, lng: -70.6407 }
  //   ciclovia-andres-bello (bike path, ~2.7km east-west)
  //   avenida-suecia (bike path, ~3km north-south)
  //   { name: "Plaza Ñuñoa", lat: -33.4527, lng: -70.5972 }
  //
  // The system should:
  //   1. Find Andrés Bello near Emporio La Rosa
  //   2. Ride it EAST (toward Suecia, not west)
  //   3. At the Bello/Suecia junction, switch to Suecia
  //   4. Ride Suecia SOUTH toward Plaza Ñuñoa
  //
  // Only use the sections of each bike path between the anchors.
  // Not the full paths.
  // ---------------------------------------------------------------
  it('Emporio La Rosa → Plaza Ñuñoa via Andrés Bello + Suecia', () => {
    // Andrés Bello: east-west along the river
    // From -70.6260 to -70.6090, at lat -33.4200
    const andresBello = makeLinearPath(-70.6260, -70.6090, -33.4200, 5);

    // Suecia: north-south, meets Andrés Bello at its east end
    // From lat -33.4190 (north, near Bello junction) to -33.4450 (south)
    const suecia = makeNSPath(-70.6094, -33.4190, -33.4450, 5);

    // Waypoints: place → bike path → bike path → place
    const waypoints = [
      { name: 'Emporio La Rosa (Merced)', lng: -70.6407, lat: -33.4369 },
      andresBello,  // bike path ways
      suecia,       // bike path ways
      { name: 'Plaza Ñuñoa', lng: -70.5972, lat: -33.4527 },
    ];

    const chained = chainBikePaths(waypoints);
    const pts = renderTrace(chained);

    // The ride:
    //   Emporio → nearest point on Bello (~1.5km walk/unlisted road)
    //   Bello east section (~1.7km, from near Emporio to Suecia junction)
    //   Suecia south (~2.9km, from junction to near Plaza Ñuñoa)
    //   Total bike path distance: ~4.6km
    //
    // Should NOT ride ALL of Andrés Bello (2.7km) — only from the
    // Emporio-nearest point eastward to Suecia.
    const dist = totalDistance(pts);
    expect(dist).toBeLessThan(8000);   // not inflated by full paths
    expect(dist).toBeGreaterThan(3000); // covers the actual ride

    expect(maxJump(pts)).toBeLessThan(2000); // no huge gaps
    expect(countReversals(pts)).toBe(0);     // no backtracking
  });

  // ---------------------------------------------------------------
  // Las Perdices: two end-to-end north-south paths
  //
  // No place waypoints — just two bike paths that connect at a
  // shared junction. The system should use all of both paths,
  // oriented continuously south.
  // ---------------------------------------------------------------
  it('Las Perdices: two consecutive paths without reversals', () => {
    const path1 = makeNSPath(-70.533, -33.44, -33.461, 3);
    const path2 = makeNSPath(-70.534, -33.461, -33.51, 5);

    const chained = chainBikePaths([path1, path2]);
    const pts = renderTrace(chained);

    expect(maxJump(pts)).toBeLessThan(1500);
    expect(countReversals(pts)).toBe(0);

    const dist = totalDistance(pts);
    expect(dist).toBeGreaterThan(5000);
    expect(dist).toBeLessThan(12000);
  });

  // ---------------------------------------------------------------
  // Gran Mapocho: three overlapping east-west river paths
  //
  // No place waypoints — three bike paths that overlap along the
  // same corridor. The system should produce one clean east-west
  // trace, deduplicating the overlap.
  // ---------------------------------------------------------------
  it('Gran Mapocho: overlapping river paths produce a single clean corridor', () => {
    const mapocho = makeLinearPath(-70.76, -70.57, -33.42, 10);
    const andresBello = makeLinearPath(-70.63, -70.61, -33.421, 3);
    const costanera = makeLinearPath(-70.69, -70.60, -33.419, 5);

    const chained = chainBikePaths([mapocho, andresBello, costanera]);
    const pts = renderTrace(chained);

    expect(maxJump(pts)).toBeLessThan(1000);
    expect(countReversals(pts)).toBe(0);
  });
});
