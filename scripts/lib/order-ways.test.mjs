import { describe, it, expect } from 'vitest';
import { orderWays } from './order-ways.mjs';
import { haversineM } from './geo.mjs';
import { readFileSync } from 'fs';

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

  // REAL DATA: Costanera Sur — 61 ways with multiple disconnected components.
  // After filtering to cycling ways: 39 ways with gaps up to 8km.
  // The stitching connects components but reversal 1 (way [3], km 2.8)
  // flips direction because a 125m gap connects to a way going the opposite
  // direction. Reversal 2 (way [22], km 10.4) happens at a 3km gap.
  it('REAL: Costanera Sur (61 ways, multi-component) should have ≤2 reversals', () => {
    const ways = JSON.parse(readFileSync(new URL('./fixtures/costanera-sur-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);
    expect(countReversals(ordered)).toBeLessThanOrEqual(2);
  });

  // REAL DATA: Salvador Gutiérrez — 27 OSM ways with the same name but
  // different road types: 10 are cycleway=track (the actual bike path),
  // the rest are residential pasajes, living streets, and tertiary roads.
  //
  // Root cause: name search returns ALL ways, not just bike infrastructure.
  it('REAL: Salvador Gutiérrez — all 27 ways produces reversals', () => {
    const ways = JSON.parse(readFileSync(new URL('./fixtures/salvador-gutierrez-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);
    expect(countReversals(ordered)).toBeGreaterThan(0); // documents the bug
  });

  // THEORY: filtering to only cycling ways (cycleway=track or highway=cycleway)
  // removes the pasajes and eliminates the reversal.
  it('REAL: Salvador Gutiérrez — only cycling ways = 0 reversals', () => {
    const ways = JSON.parse(readFileSync(new URL('./fixtures/salvador-gutierrez-ways.json', import.meta.url), 'utf8'));
    const cyclingOnly = ways.filter(w =>
      w.tags?.cycleway === 'track' ||
      w.tags?.cycleway === 'lane' ||
      w.tags?.cycleway === 'shared_lane' ||
      w.tags?.highway === 'cycleway'
    );
    const ordered = orderWays(cyclingOnly);
    expect(countReversals(ordered)).toBe(0);
  });

  // REAL DATA: Pedro Aguirre Cerda — 90 cycling ways, many oneway=yes
  // parallel pairs (110 pairs within 50m with similar bearing).
  // The bike path is mapped as two one-way lanes ~15m apart.
  // orderWays should treat parallel oneway pairs as duplicates and
  // keep only one direction. Currently: 8 reversals from zigzagging
  // between the two lanes.
  it('REAL: Pedro Aguirre Cerda (oneway parallel lanes) should have ≤4 reversals', () => {
    const ways = JSON.parse(readFileSync(new URL('./fixtures/pedro-aguirre-cerda-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);
    expect(countReversals(ordered)).toBeLessThanOrEqual(4);
  });

  // THEORY 1: Pedro reversal [4] — 13km gap stitching.
  // The stitching connects a component ending at -33.36 to a way starting
  // at -33.47. These are 13km apart — clearly different sections of the city.
  // Stitching with gaps >5km should not create reversals.
  it('THEORY: stitching across >5km gap should not reverse direction', () => {
    // Two components: one going NE, one going SW, 6km apart
    const ways = [];
    // Component 1: 3 ways going NE
    for (let i = 0; i < 3; i++) {
      ways.push(makeWay(i, [[-70.68 + i*0.005, -33.47 - i*0.005], [-70.68 + (i+1)*0.005, -33.47 - (i+1)*0.005]]));
    }
    // Component 2: 3 ways going NE, 6km south (separate area)
    for (let i = 0; i < 3; i++) {
      ways.push(makeWay(10+i, [[-70.72 + i*0.005, -33.52 - i*0.005], [-70.72 + (i+1)*0.005, -33.52 - (i+1)*0.005]]));
    }
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    // Both components go NE — stitching should not reverse either
    expect(countReversals(ordered)).toBe(0);
  });

  // THEORY 2: Pedro reversals [16-17] — oneway way meets non-oneway way.
  // Way 272519482 (oneway=yes, 41°) → way 94451925 (oneway=-, 219°).
  // The oneway dedup only catches pairs where BOTH have oneway=yes.
  // When a oneway way meets a non-tagged way going the opposite direction,
  // the dedup misses it and the walk zigzags.
  it('THEORY: oneway + non-oneway parallel should still be deduped', () => {
    const ways = [
      { ...makeWay(1, [[-70.70, -33.49], [-70.69, -33.48]]), tags: { oneway: 'yes' } }, // NE
      { ...makeWay(2, [[-70.69, -33.48], [-70.70, -33.49]]) },                           // SW, NO oneway tag
      { ...makeWay(3, [[-70.69, -33.48], [-70.68, -33.47]]), tags: { oneway: 'yes' } }, // continues NE
    ];
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    // Way 2 is the return lane without oneway tag — should be deduped
    expect(countReversals(ordered)).toBe(0);
  });

  // THEORY (DISPROVEN): anti-parallel oneway dedup drops the wrong lane.
  // Actual root cause: parallel-overlap dedup removes a short oneway segment
  // (995747536, 97m SW) because it overlaps with a long non-oneway way
  // (94451925, 3049m). This leaves no SW oneway entry at the junction,
  // forcing the walk to take an opposing NE oneway (272519482).
  // The fix requires topology-aware veto in parallel-overlap dedup, but
  // attempts to implement this regressed Pedro (4→7) because the veto
  // kept too many oneway segments.
  // Keeping this test as a marker for the unsolved problem.
  it.skip('THEORY: parallel-overlap dedup should preserve topologically critical oneways', () => {
    // This test represents the pattern but the fix is not yet implemented.
    // See forensic tests below for the real-data proof.
    expect(true).toBe(true);
  });

  // THEORY 3b: same as above but with more context — 4 SW ways and 1 NE way.
  // The dominant direction is clearly SW. The NE oneway should be dropped.
  it('THEORY: orphan oneway against dominant direction should be dropped', () => {
    const ways = [
      { ...makeWay(1, [[-70.69, -33.48], [-70.695, -33.485]]), tags: { oneway: 'yes' } },  // SW
      { ...makeWay(2, [[-70.695, -33.485], [-70.70, -33.489]]), tags: { oneway: 'yes' } },  // SW
      { ...makeWay(3, [[-70.70, -33.489], [-70.704, -33.493]]), tags: { oneway: 'yes' } },  // SW
      { ...makeWay(4, [[-70.704, -33.493], [-70.698, -33.486]]), tags: { oneway: 'yes' } },  // NE (opposite!)
      { ...makeWay(5, [[-70.704, -33.493], [-70.71, -33.50]]) },                              // SW continuation
    ];
    ways.sort(() => Math.random() - 0.5);
    const ordered = orderWays(ways);
    expect(countReversals(ordered)).toBe(0);
  });

  // REAL DATA — Pedro Aguirre Cerda reversal forensics.
  // Pedro has 90 ways (79 oneway), going SW along a corridor.
  // After oneway dedup, 28 ways remain with 4 reversals.
  // These tests prove WHERE and WHY each reversal happens.

  it('REAL: Pedro reversal 2-3 — way 272519482 (NE) sandwiched between SW ways', () => {
    // The walk goes: ...450026407 (SW) → 272519482 (NE) → 94451925 (SW)
    // Way 272519482 is a 1073m oneway going NE. Its parallel SW lane (450026407)
    // was NOT deduped because midpoints are 260m apart. Both survive in the graph.
    // The walk enters 272519482 legally (from its start cluster, respecting oneway).
    // But it creates a reversal because the path is going SW.
    const ways = JSON.parse(readFileSync(new URL('./fixtures/pedro-aguirre-cerda-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);

    // Find way 272519482 in the output
    const idx272 = ordered.findIndex(w => w.id === 272519482);
    expect(idx272, 'way 272519482 should be in the output').toBeGreaterThan(-1);

    // Assert it's entered non-reversed (NE direction, matching its oneway)
    expect(ordered[idx272]._reversed).toBe(false);

    // Assert the previous way goes SW and the next goes SW — it's sandwiched
    if (idx272 > 0) {
      const prev = ordered[idx272 - 1];
      const prevCoords = prev.geometry.map(p => [p.lon, p.lat]);
      const prevTrace = prev._reversed ? [...prevCoords].reverse() : prevCoords;
      const prevBearing = Math.atan2(
        prevTrace[prevTrace.length - 1][0] - prevTrace[0][0],
        prevTrace[prevTrace.length - 1][1] - prevTrace[0][1],
      ) * 180 / Math.PI;
      // Previous way should be going SW (180-270°)
      expect(prevBearing).toBeLessThan(-90);
    }
  });

  it('REAL: Pedro — way 272519482 and 450026407 are anti-parallel but NOT deduped', () => {
    // These two ways are true parallel lanes of the same corridor:
    // 272519482: NE oneway, 1073m
    // 450026407: SW oneway, 490m
    // They share one endpoint (33m apart) but midpoints are 260m apart.
    // The midpoint-based oneway dedup (threshold 100m) misses them.
    const ways = JSON.parse(readFileSync(new URL('./fixtures/pedro-aguirre-cerda-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);

    const has272 = ordered.some(w => w.id === 272519482);
    const has450 = ordered.some(w => w.id === 450026407);
    // BOTH survive — proving the dedup doesn't catch this anti-parallel pair
    expect(has272, 'way 272519482 (NE) survives dedup').toBe(true);
    expect(has450, 'way 450026407 (SW) survives dedup').toBe(true);
  });

  it('REAL: Pedro — way 272519482 has no SW alternative at its entry junction', () => {
    // WHY does the walk pick 272519482 (NE)? Is it because there's no better
    // candidate at the junction, or because the scoring picks it over alternatives?
    // This test checks what the walk sees at the junction.
    const ways = JSON.parse(readFileSync(new URL('./fixtures/pedro-aguirre-cerda-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);

    const idx272 = ordered.findIndex(w => w.id === 272519482);
    expect(idx272).toBeGreaterThan(-1);

    // Way 272519482's start is at [-70.704201, -33.4934206]
    // Check: how many other unused ways connect to this junction cluster?
    // If 272519482 is the ONLY candidate, the walk has no choice.
    // If there ARE alternatives, the scoring is wrong.
    const w272 = ways.find(w => w.id === 272519482);
    const startPt = [w272.geometry[0].lon, w272.geometry[0].lat];

    // Count ways that start or end within 40m of 272519482's start
    const nearbyWays = ways.filter(w => {
      if (w.id === 272519482) return false;
      const g = w.geometry;
      const s = [g[0].lon, g[0].lat];
      const e = [g[g.length - 1].lon, g[g.length - 1].lat];
      return haversineM(startPt, s) < 40 || haversineM(startPt, e) < 40;
    });

    // Log what's there (this is a diagnostic assertion — we want to know)
    const nearbyInfo = nearbyWays.map(w => ({
      id: w.id,
      oneway: w.tags?.oneway || 'no',
      bearing: Math.round(Math.atan2(
        w.geometry[w.geometry.length - 1].lon - w.geometry[0].lon,
        w.geometry[w.geometry.length - 1].lat - w.geometry[0].lat,
      ) * 180 / Math.PI),
    }));

    // There should be at least one nearby way — the question is whether
    // any of them go SW and were available when the walk reached this junction
    expect(nearbyWays.length, 'ways near 272519482 start: ' + JSON.stringify(nearbyInfo)).toBeGreaterThan(0);
  });

  it('REAL: Pedro — 995747536 (SW) was deduped, so walk has no SW choice at junction', () => {
    // At 272519482's start junction, 995747536 (SW oneway, 97m) was the only
    // SW alternative. But it was removed by parallel-overlap dedup (absorbed
    // into 94451925, a 3049m way on the same corridor). With 995747536 gone,
    // the walk's only legal oneway entry at this junction is 272519482 (NE),
    // creating a reversal.
    const ways = JSON.parse(readFileSync(new URL('./fixtures/pedro-aguirre-cerda-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);

    // 995747536 is NOT in output (deduped)
    expect(ordered.some(w => w.id === 995747536)).toBe(false);
    // 272519482 IS in output (no SW alternative, walk forced to take it)
    expect(ordered.some(w => w.id === 272519482)).toBe(true);
    // 94451925 IS in output (the long way that absorbed 995747536's corridor)
    expect(ordered.some(w => w.id === 94451925)).toBe(true);
  });

  it('REAL: Pedro — way 995747536 (SW, 97m) was deduped, leaving no SW option at junction', () => {
    // 995747536 is a short 97m SW oneway at the same junction as 272519482 (NE).
    // It gets deduped — but it's the ONLY SW alternative at that junction.
    // Without it, the walk is forced to take 272519482 (NE), creating a reversal.
    // This test proves the root cause: the dedup removes a critical SW way.
    const ways = JSON.parse(readFileSync(new URL('./fixtures/pedro-aguirre-cerda-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);

    const has995 = ordered.some(w => w.id === 995747536);
    // Currently false — this is the root cause of reversal 2-3
    expect(has995, 'way 995747536 (97m SW) is deduped — root cause of reversal').toBe(false);
  });

  it('REAL: Pedro — both 995747536 and 1394083971 are deduped', () => {
    // 995747536 (SW, 97m) and 1394083971 (NE, 96m) are anti-parallel twins.
    // Same-cluster-pair dedup drops 1394083971 (shorter), keeps 995747536.
    // Then the PARALLEL-OVERLAP dedup drops 995747536 because it's a 97m
    // segment that overlaps with way 94451925 (3049m, same bearing, 109m away).
    // This is a CORRECT dedup — 995747536 IS a sub-segment of the same corridor.
    // But its removal leaves no SW candidate at the junction where 272519482
    // starts, forcing the walk to take the NE oneway and create a reversal.
    // ROOT CAUSE: the parallel-overlap dedup correctly removes a tiny segment
    // that is also the only SW connection at a critical junction.
    const ways = JSON.parse(readFileSync(new URL('./fixtures/pedro-aguirre-cerda-ways.json', import.meta.url), 'utf8'));
    const ordered = orderWays(ways);
    expect(ordered.some(w => w.id === 995747536), '995747536 dropped by parallel-overlap').toBe(false);
    expect(ordered.some(w => w.id === 1394083971), '1394083971 dropped by same-cluster-pair').toBe(false);
    // 94451925 (3049m) absorbs 995747536's corridor coverage
    expect(ordered.some(w => w.id === 94451925), '94451925 survives and covers the corridor').toBe(true);
  });

  it('REAL: Pedro — WHY is 995747536 deduped? Check which pass drops it', () => {
    // 995747536 is 97m, oneway=yes, bearing -144° (SW).
    // Possible dedup reasons:
    //   1. Self-loop (start==end cluster) — unlikely, it's a straight segment
    //   2. Tiny fragment (<40m) — NO, it's 97m
    //   3. Same-cluster-pair — dropped as duplicate of a longer way on the same cluster pair?
    //   4. Oneway lane dedup — dropped as parallel to a co-parallel or anti-parallel lane?
    //   5. Parallel-overlap dedup — dropped as corridor overlap?
    const ways = JSON.parse(readFileSync(new URL('./fixtures/pedro-aguirre-cerda-ways.json', import.meta.url), 'utf8'));
    const w995 = ways.find(w => w.id === 995747536);
    const g = w995.geometry;
    const start = [g[0].lon, g[0].lat];
    const end = [g[g.length - 1].lon, g[g.length - 1].lat];

    // Check: what other ways share the same cluster pair?
    // (i.e., start within 40m AND end within 40m of 995747536's endpoints)
    const samePair = ways.filter(w => {
      if (w.id === 995747536) return false;
      const wg = w.geometry;
      const ws = [wg[0].lon, wg[0].lat];
      const we = [wg[wg.length - 1].lon, wg[wg.length - 1].lat];
      // Same cluster pair: (start≈start AND end≈end) OR (start≈end AND end≈start)
      return (haversineM(start, ws) < 40 && haversineM(end, we) < 40) ||
             (haversineM(start, we) < 40 && haversineM(end, ws) < 40);
    });

    // These are the ways 995747536 competes with in same-cluster-pair dedup
    const pairInfo = samePair.map(w => {
      const wg = w.geometry;
      let len = 0;
      for (let i = 1; i < wg.length; i++) len += haversineM([wg[i-1].lon, wg[i-1].lat], [wg[i].lon, wg[i].lat]);
      return { id: w.id, len: Math.round(len), oneway: w.tags?.oneway || 'no' };
    });

    // Expect at least one competitor — that's what deduped it
    expect(pairInfo.length, 'same-pair competitors: ' + JSON.stringify(pairInfo)).toBeGreaterThan(0);
  });

  // REGRESSION GUARD: lock in reversal counts for all real fixtures.
  // If a code change increases reversals for any fixture, the test fails.
  // These numbers are the BEST we've achieved — don't regress.
  it('REGRESSION: fixture reversal counts should not increase', () => {
    const maxReversals = {
      'pocuro-ways': 2,
      'costanera-sur-ways': 2,
      'noviciado-ways': 0,
      'salvador-gutierrez-ways': 2, // full 27 ways including non-cycling; cycling-filtered = 0
      'mapocho-42k-ways': 0,
      'avenida-mapocho-ways': 0,
      'sanchez-fontecilla-ways': 0,
      'antonio-varas-ways': 0,
      'los-morros-ways': 0,
      'duble-almeyda-ways': 0,
      'vicuna-mackenna-ways': 0,
      'pedro-aguirre-cerda-ways': 4,
    };
    for (const [file, maxRev] of Object.entries(maxReversals)) {
      const ways = JSON.parse(readFileSync(new URL('./fixtures/' + file + '.json', import.meta.url), 'utf8'));
      const ordered = orderWays(ways);
      const revs = countReversals(ordered);
      expect(revs, file + ' has ' + revs + ' reversals (max ' + maxRev + ')').toBeLessThanOrEqual(maxRev);
    }
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
