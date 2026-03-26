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
  // REAL DATA: Pocuro → Antonio Varas → Costanera Sur
  // Combined route bearing 279° (E→W), should go W→E.
  // The 3 bike paths run roughly east-west through Providencia.
  // The chain should produce a continuous W→E trace.
  it('REAL: Pocuro a Parque Forestal should go W→E with 0 reversals', () => {
    const pocuro = JSON.parse(readFileSync(new URL('./fixtures/pocuro-ways.json', import.meta.url), 'utf8'));
    const varas = JSON.parse(readFileSync(new URL('./fixtures/antonio-varas-ways.json', import.meta.url), 'utf8'));
    const costanera = JSON.parse(readFileSync(new URL('./fixtures/costanera-sur-ways.json', import.meta.url), 'utf8'));

    const orderedPocuro = orderWays(pocuro);
    const orderedVaras = orderWays(varas);
    const orderedCostanera = orderWays(costanera);

    const segments = chainBikePaths([orderedPocuro, orderedVaras, orderedCostanera]);
    const pts = renderTrace(segments);

    // Should go W→E (east end has less negative longitude)
    expect(pts[pts.length - 1][0]).toBeGreaterThan(pts[0][0]);

    // Should not have excessive reversals
    expect(countReversals(pts)).toBeLessThanOrEqual(3);

    // Distance should be reasonable (not inflated by backtracking)
    const dist = totalDistance(pts);
    expect(dist).toBeLessThan(20000); // ~15km at most, not 30+
  });
});

describe('chainBikePaths', () => {
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
