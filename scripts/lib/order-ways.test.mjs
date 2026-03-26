import { describe, it, expect } from 'vitest';
import { orderWays } from './order-ways.mjs';
import { haversineM } from './geo.mjs';

function makeWay(id, coords) {
  return {
    id,
    geometry: coords.map(([lon, lat]) => ({ lon, lat })),
  };
}

function renderTrace(ordered) {
  const pts = [];
  let prev = null;
  for (const w of ordered) {
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

  // Direction convention: W→E for east-west paths, N→S for north-south paths
  it('east-west path should go west to east', () => {
    const ways = [];
    for (let i = 0; i < 5; i++) {
      ways.push(makeWay(i, [[-70.70 + i * 0.02, -33.42], [-70.70 + (i + 1) * 0.02, -33.42]]));
    }
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    const startLng = pts[0][0];
    const endLng = pts[pts.length - 1][0];
    expect(endLng).toBeGreaterThan(startLng); // east end has higher (less negative) longitude
  });

  it('north-south path should go north to south', () => {
    const ways = [];
    for (let i = 0; i < 5; i++) {
      ways.push(makeWay(i, [[-70.60, -33.42 - i * 0.01], [-70.60, -33.42 - (i + 1) * 0.01]]));
    }
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    const startLat = pts[0][1];
    const endLat = pts[pts.length - 1][1];
    expect(endLat).toBeLessThan(startLat); // south has more negative latitude
  });

  // Diagonal path (NW-SE) should go NW→SE (more west, more south = SE end)
  // Reproduces ciclovia-el-noviciado: bearing 319° classified as N-S but
  // it's really a diagonal. The convention for diagonals going NW-SE should
  // prefer the direction where BOTH longitude increases and latitude decreases.
  it('diagonal NW-SE path should go NW to SE', () => {
    const ways = [];
    for (let i = 0; i < 5; i++) {
      ways.push(makeWay(i, [
        [-70.85 + i * 0.006, -33.40 - i * 0.008],
        [-70.85 + (i + 1) * 0.006, -33.40 - (i + 1) * 0.008],
      ]));
    }
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    // Should go from NW (-70.85, -33.40) toward SE (-70.82, -33.44)
    // NW has more negative lng, less negative lat
    // SE has less negative lng, more negative lat
    const startLng = pts[0][0];
    const endLng = pts[pts.length - 1][0];
    expect(endLng).toBeGreaterThan(startLng); // going east (lng increasing)
  });

  // Path that goes north (S→N): the walk may pick the wrong start.
  // Reproduces ciclovia-los-morros: 0 reversals but wrong direction.
  // The walk correctly orders the ways but starts from the south end.
  it('short north-south path with shuffled ways goes N→S', () => {
    // 4 ways going south, but stored in mixed directions
    const ways = [
      makeWay(1, [[-70.67, -33.56], [-70.67, -33.55]]),   // stored S→N
      makeWay(2, [[-70.67, -33.55], [-70.67, -33.54]]),   // stored S→N
      makeWay(3, [[-70.67, -33.58], [-70.67, -33.57]]),   // stored S→N
      makeWay(4, [[-70.67, -33.57], [-70.67, -33.56]]),   // stored S→N
    ];
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    const startLat = pts[0][1];
    const endLat = pts[pts.length - 1][1];
    // N→S means start is less negative (north), end is more negative (south)
    expect(startLat).toBeGreaterThan(endLat);
  });

  // ---------------------------------------------------------------
  // REAL-WORLD DIRECTION PATTERNS
  // Each test reproduces the exact bearing/geometry of a real Santiago
  // bike path that currently goes the wrong direction.
  // ---------------------------------------------------------------

  // Clotario Blest: bearing 203° (SSW). dlng=-0.018, dlat=-0.044.
  // Primarily N-S (more lat change than lng change), going south.
  // N→S convention says this is CORRECT. But it also goes west.
  // Expected: N→S (south end at the end, north at the start)
  it('SSW path (bearing 203°, like Clotario Blest) goes N→S', () => {
    const ways = [];
    for (let i = 0; i < 5; i++) {
      ways.push(makeWay(i, [
        [-70.669 - i * 0.004, -33.479 - i * 0.009],
        [-70.669 - (i + 1) * 0.004, -33.479 - (i + 1) * 0.009],
      ]));
    }
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    // N→S: start should be more north (less negative lat)
    expect(pts[0][1]).toBeGreaterThan(pts[pts.length - 1][1]);
  });

  // Los Morros: bearing 195° (almost due south, slight west). dlng=-0.01, dlat=-0.037.
  // Clearly N-S. Should go N→S.
  it('nearly due-south path (bearing 195°, like Los Morros) goes N→S', () => {
    const ways = [];
    for (let i = 0; i < 4; i++) {
      ways.push(makeWay(i, [
        [-70.676 - i * 0.003, -33.543 - i * 0.009],
        [-70.676 - (i + 1) * 0.003, -33.543 - (i + 1) * 0.009],
      ]));
    }
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    expect(pts[0][1]).toBeGreaterThan(pts[pts.length - 1][1]); // N→S
  });

  // El Noviciado: bearing 319° (NW). dlng=-0.027, dlat=+0.032.
  // Goes northwest. Ambiguous — going both north AND west.
  // Since it goes more north than west (dlat > dlng), classify as N-S.
  // But N→S convention says going north is wrong — should reverse to SE→NW...
  // which goes WEST. So neither convention is clean.
  // For NW diagonals: prefer the direction that goes more east.
  // NW→SE goes east. SE→NW goes west. So NW→SE is correct.
  it('NW diagonal (bearing 319°, like El Noviciado) ends going east', () => {
    const ways = [
      makeWay(1, [[-70.852, -33.405], [-70.845, -33.412], [-70.838, -33.418]]),
      makeWay(2, [[-70.838, -33.418], [-70.832, -33.425], [-70.825, -33.437]]),
    ];
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    // Should end more east (less negative lng) than it started
    expect(pts[pts.length - 1][0]).toBeGreaterThan(pts[0][0]);
  });

  // REAL DATA: Ciclovía Pocuro — 15 actual OSM ways.
  // bearing 254° (WSW), should go W→E.
  it('REAL: Pocuro (15 OSM ways, bearing 254°) should go W→E', () => {
    const { readFileSync } = require('fs');
    const ways = JSON.parse(readFileSync(new URL('./fixtures/pocuro-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    expect(pts[pts.length - 1][0]).toBeGreaterThan(pts[0][0]); // W→E
  });

  // REAL DATA: Ciclovia El Noviciado — 1 OSM way, bearing 319° (NW diagonal).
  // Single-way path stored SE→NW in OSM. Should be reversed to go NW→SE
  // (toward the east). The direction enforcement must work on single-way
  // paths too, not just multi-way walks.
  it('REAL: El Noviciado (1 OSM way, bearing 319°) should end going east', () => {
    const { readFileSync } = require('fs');
    const ways = JSON.parse(readFileSync(new URL('./fixtures/noviciado-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    expect(pts[pts.length - 1][0]).toBeGreaterThan(pts[0][0]); // end lng > start = going east
  });

  // Reproduces ciclovia-el-noviciado: diagonal NW→SE path at bearing ~319°.
  // This is classified as N-S (319° is between 315-360°), and the N→S
  // convention reverses it to SE→NW, which goes WEST — wrong.
  // Convention should prefer the direction with an eastward component.
  it('El Noviciado pattern: diagonal NW-SE at 319° → should go SE to NW (eastward)', () => {
    // Path goes from SE (-70.825, -33.437) to NW (-70.852, -33.405)
    // That's bearing ~319° — going NW. Reverse should go SE→NW... wait.
    // Actually going NW means dlng < 0 (more west) — that's the wrong direction.
    // The correct direction should have dlng > 0 (going east).
    // So the path should go NW→SE: from (-70.852, -33.405) to (-70.825, -33.437)
    const ways = [
      makeWay(1, [[-70.852, -33.405], [-70.845, -33.412], [-70.838, -33.418]]),
      makeWay(2, [[-70.838, -33.418], [-70.832, -33.425], [-70.825, -33.437]]),
    ];
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    const startLng = pts[0][0];
    const endLng = pts[pts.length - 1][0];
    // Should go toward the east (less negative lng)
    expect(endLng).toBeGreaterThan(startLng);
  });

  // THEORY: single way gets _reversed=undefined because it doesn't go
  // through the graph walk (no edges to traverse) or gets dropped.
  it('single way should have _reversed set (not undefined)', () => {
    const ways = [makeWay(1, [[-70.825, -33.437], [-70.835, -33.430], [-70.852, -33.405]])];
    const ordered = orderWays(ways);
    expect(ordered).toHaveLength(1); // way must survive
    expect(ordered[0]._reversed).toBeDefined();
  });

  // THEORY: single way is being dropped by dedup (self-loop or fragment check)
  it('single 4km way should not be dropped by dedup', () => {
    const { readFileSync } = require('fs');
    const ways = JSON.parse(readFileSync(new URL('./fixtures/noviciado-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);
    expect(ordered).toHaveLength(1);
  });

  // THEORY: single way returns the original object (not a copy from doWalk)
  // meaning it never goes through the graph walk at all
  it('single way should return a NEW object (copy from walk), not the input', () => {
    const ways = [makeWay(1, [[-70.825, -33.437], [-70.835, -33.430], [-70.852, -33.405]])];
    const ordered = orderWays(ways);
    expect(ordered[0]).not.toBe(ways[0]); // must be a copy, not same reference
  });

  // THEORY: single-component multi-way paths return early (line 384:
  // `if (walked.length === 1) return walked[0].ways`) before any
  // post-stitch direction check. If enforceDirection inside walkComponent
  // produces the wrong direction AND the early return fires, the result
  // is wrong with no second chance to fix it.
  // Test: a single-component E→W path should still get W→E direction.
  it('single-component path should not bypass direction enforcement', () => {
    // 5 ways that form one connected component, going E→W
    // (all stored east-to-west, which is the wrong direction)
    const ways = [];
    for (let i = 0; i < 5; i++) {
      const lng1 = -70.59 - i * 0.006;
      const lng2 = lng1 - 0.006;
      ways.push(makeWay(i, [[lng1, -33.43 - i * 0.001], [lng2, -33.43 - (i + 1) * 0.001]]));
    }
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    // Should go W→E (end lng > start lng)
    expect(pts[pts.length - 1][0]).toBeGreaterThan(pts[0][0]);
  });

  // DIAGNOSTIC: Pocuro has _reversed defined on all ways.
  // The direction is wrong despite flags being set.
  // Check: is the overall bearing classified as E-W or N-S?
  // Pocuro overall bearing is 254° — that's in the 225-315 range (E-W).
  // So isEW=true, and dlng<0 means wrong. enforceDirection SHOULD reverse.
  // But it doesn't. WHY?
  //
  // THEORY: enforceDirection runs per-component inside walkComponent.
  // If Pocuro has 2 components, each component's local bearing may be
  // different from 254°. If a component has bearing ~200° (classified as
  // N-S, going south = correct), enforceDirection won't reverse it.
  // Then the stitched result is E→W but no post-stitch check exists.
  it('REAL: Pocuro — per-component bearings may differ from overall bearing', () => {
    const { readFileSync } = require('fs');
    const ways = JSON.parse(readFileSync(new URL('./fixtures/pocuro-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);

    // Find component boundaries (gaps > 100m in the rendered trace)
    const compStarts = [0];
    for (let i = 1; i < pts.length; i++) {
      if (haversineM(pts[i - 1], pts[i]) > 100) compStarts.push(i);
    }

    // For each component, compute bearing
    const compBearings = [];
    for (let c = 0; c < compStarts.length; c++) {
      const start = compStarts[c];
      const end = c + 1 < compStarts.length ? compStarts[c + 1] - 1 : pts.length - 1;
      const s = pts[start], e = pts[end];
      const dlng = e[0] - s[0], dlat = e[1] - s[1];
      const b = Math.round((Math.atan2(dlng, dlat) * 180 / Math.PI + 360) % 360);
      const isEW = (b >= 45 && b < 135) || (b >= 225 && b < 315);
      compBearings.push({ b, isEW, dlng: dlng.toFixed(4), dlat: dlat.toFixed(4) });
    }

    // If ANY component has a bearing classified as N-S (not E-W) while
    // the overall path is E-W, that's the bug: enforceDirection misclassifies
    // the component and doesn't reverse it.
    const overallDlng = pts[pts.length - 1][0] - pts[0][0];
    const overallB = Math.round((Math.atan2(overallDlng, pts[pts.length - 1][1] - pts[0][1]) * 180 / Math.PI + 360) % 360);
    const overallIsEW = (overallB >= 45 && overallB < 135) || (overallB >= 225 && overallB < 315);

    // After fix: post-stitch enforcement reverses the result to W→E.
    expect(overallIsEW).toBe(true); // overall is E-W
    expect(overallDlng).toBeGreaterThan(0); // now going east = correct
  });

  // REAL DATA: Salvador Gutiérrez — 27 OSM ways with the same name but
  // different road types: 10 are cycleway=track (the actual bike path),
  // the rest are residential pasajes, living streets, and tertiary roads.
  // The non-bike ways (especially living_street near -70.705) create a
  // loop at the end of the trace: the walk visits the pasaje, backtracks.
  //
  // Root cause: name search returns ALL ways, not just bike infrastructure.
  // The bike path is 3.8km. With pasajes included, the trace is 7.3km
  // with a 1.3km backtrack loop at the end.
  it('REAL: Salvador Gutiérrez should have 0 reversals (no pasaje loop)', () => {
    const ways = JSON.parse(readFileSync(new URL('./fixtures/salvador-gutierrez-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);
    const pts = renderTrace(ordered);
    expect(countReversals(ordered)).toBe(0);
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
