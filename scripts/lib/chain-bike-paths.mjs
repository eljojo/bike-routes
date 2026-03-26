/**
 * Chain a mixed list of waypoints (places and bike paths) into a segmented
 * GPX trace. Each bike path is trimmed to the section relevant to the route,
 * oriented correctly, and consecutive paths within 200m are merged into one
 * segment.
 *
 * @param {Array} waypoints - mixed: { lat, lng } places and Array<way> bike paths
 * @returns {Array<Array<way>>} segments, each an array of oriented ways
 */

import { haversineM, nearestPointOnPolyline } from './geo.mjs';

function isPlace(wp) {
  return !Array.isArray(wp) && wp.lat != null && wp.lng != null;
}

/** Build a measured polyline from ways, deduplicating junction points. */
function buildPoly(ways) {
  const coords = [];
  for (const w of ways) {
    for (const p of w.geometry) {
      const c = [p.lon, p.lat];
      if (coords.length > 0 && haversineM(coords[coords.length - 1], c) < 1) continue;
      coords.push(c);
    }
  }
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + haversineM(coords[i - 1], coords[i]));
  }
  return { coords, cum, len: cum[cum.length - 1] || 0 };
}

/** Closest pair between two polylines with endpoint tie-breaking. */
function closestPair(pA, pB) {
  let best = Infinity;
  const cands = [];

  for (let i = 0; i < pA.coords.length; i++) {
    const p = nearestPointOnPolyline(pA.coords[i], pB.coords);
    if (p.dist < best) best = p.dist;
    cands.push({ sA: pA.cum[i], sB: p.scalar, d: p.dist });
  }
  for (let i = 0; i < pB.coords.length; i++) {
    const p = nearestPointOnPolyline(pB.coords[i], pA.coords);
    if (p.dist < best) best = p.dist;
    cands.push({ sA: p.scalar, sB: pB.cum[i], d: p.dist });
  }

  const thr = Math.max(best * 1.1, best + 50);
  const near = cands.filter(c => c.d <= thr);

  let pick = near[0];
  let pickED = Math.min(pick.sB, pB.len - pick.sB);
  for (let i = 1; i < near.length; i++) {
    const ed = Math.min(near[i].sB, pB.len - near[i].sB);
    if (ed < pickED) { pickED = ed; pick = near[i]; }
  }
  return pick;
}

/** Interpolate a coordinate at scalar s on poly. */
function interp(poly, s) {
  if (s <= 0) return poly.coords[0];
  if (s >= poly.len) return poly.coords[poly.coords.length - 1];
  for (let i = 1; i < poly.cum.length; i++) {
    if (poly.cum[i] >= s - 0.01) {
      const t = poly.cum[i] > poly.cum[i - 1]
        ? (s - poly.cum[i - 1]) / (poly.cum[i] - poly.cum[i - 1])
        : 0;
      return [
        poly.coords[i - 1][0] + t * (poly.coords[i][0] - poly.coords[i - 1][0]),
        poly.coords[i - 1][1] + t * (poly.coords[i][1] - poly.coords[i - 1][1]),
      ];
    }
  }
  return poly.coords[poly.coords.length - 1];
}

const MAX_STEP = 500; // metres — densify if gap exceeds this

/**
 * Slice polyline between two scalars.
 * Returns [lng,lat] coords in travel order (reversed if from > to).
 * Includes interpolated start/end points plus all interior polyline vertices.
 * Densifies by interpolating additional points where vertex spacing exceeds MAX_STEP.
 */
function slicePoly(poly, from, to) {
  const fwd = from <= to;
  const lo = Math.min(from, to), hi = Math.max(from, to);

  // Collect raw vertices (interpolated start, interior, interpolated end)
  const raw = [interp(poly, lo)];
  for (let i = 0; i < poly.coords.length; i++) {
    if (poly.cum[i] > lo + 0.5 && poly.cum[i] < hi - 0.5) {
      raw.push(poly.coords[i]);
    }
  }
  const end = interp(poly, hi);
  if (haversineM(raw[raw.length - 1], end) > 0.5) raw.push(end);

  // Densify: insert interpolated points where gaps exceed MAX_STEP
  const pts = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const d = haversineM(raw[i - 1], raw[i]);
    if (d > MAX_STEP) {
      const steps = Math.ceil(d / MAX_STEP);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        pts.push([
          raw[i - 1][0] + t * (raw[i][0] - raw[i - 1][0]),
          raw[i - 1][1] + t * (raw[i][1] - raw[i - 1][1]),
        ]);
      }
    }
    pts.push(raw[i]);
  }

  if (!fwd) pts.reverse();
  return pts;
}

export function chainBikePaths(waypoints) {
  if (waypoints.length === 0) return [[]];

  const cls = waypoints.map(wp =>
    isPlace(wp) ? { type: 'place', data: wp }
      : { type: 'path', data: wp, poly: buildPoly(wp) }
  );

  const paths = [];
  for (let i = 0; i < cls.length; i++) {
    if (cls[i].type === 'path') paths.push({ idx: i, ...cls[i] });
  }
  if (paths.length === 0) return [[]];

  const B = new Map();
  for (const p of paths) B.set(p.idx, { in: null, out: null });

  // Solve boundaries
  for (const cur of paths) {
    const b = B.get(cur.idx);
    const prev = cur.idx > 0 ? cls[cur.idx - 1] : null;
    const next = cur.idx < cls.length - 1 ? cls[cur.idx + 1] : null;

    if (prev?.type === 'place') {
      b.in = nearestPointOnPolyline([prev.data.lng, prev.data.lat], cur.poly.coords).scalar;
    } else if (prev?.type === 'path') {
      const r = closestPair(prev.poly, cur.poly);
      b.in = r.sB;
      const pb = B.get(cur.idx - 1);
      if (pb) pb.out = r.sA;
    }

    if (next?.type === 'place') {
      b.out = nearestPointOnPolyline([next.data.lng, next.data.lat], cur.poly.coords).scalar;
    }
  }

  // Resolve unconstrained
  for (let pi = 0; pi < paths.length; pi++) {
    const pe = paths[pi];
    const b = B.get(pe.idx);
    const L = pe.poly.len;

    if (b.in === null && b.out === null) {
      b.in = 0; b.out = L;
    } else if (b.in === null) {
      b.in = Math.abs(0 - b.out) >= Math.abs(L - b.out) ? 0 : L;
    } else if (b.out === null) {
      let prevFwd = null;
      if (pi > 0) {
        const pb = B.get(paths[pi - 1].idx);
        if (pb?.in !== null && pb?.out !== null) prevFwd = pb.out >= pb.in;
      }
      if (prevFwd !== null) {
        b.out = prevFwd ? L : 0;
      } else {
        b.out = Math.abs(b.in - L) >= Math.abs(b.in - 0) ? L : 0;
      }
    }
  }

  // Build coordinate sequences, then assemble into segments
  const pathCoords = []; // { coords: [[lng,lat],...], id, reversed }
  for (const pe of paths) {
    const b = B.get(pe.idx);
    const coords = slicePoly(pe.poly, b.in, b.out);
    if (coords.length < 2) continue;
    pathCoords.push({
      coords,
      id: pe.data[0].id,
      reversed: b.in > b.out,
    });
  }

  // Assemble into segments with 200m gap threshold.
  // At path junctions within a segment, merge the connection:
  // remove duplicate/near-duplicate points at the boundary.
  const segments = [];
  let seg = null;
  let segCoords = null; // track all coords in current segment for dedup

  for (let pi = 0; pi < pathCoords.length; pi++) {
    const pc = pathCoords[pi];

    if (seg === null) {
      seg = [];
      segCoords = [];
      segments.push(seg);
    } else {
      // Check gap between last point in segment and first of this path
      const lastC = segCoords[segCoords.length - 1];
      const firstC = pc.coords[0];
      const gap = haversineM(lastC, firstC);

      if (gap > 200) {
        seg = [];
        segCoords = [];
        segments.push(seg);
      }
    }

    // Build this path's coords, deduplicating with segment end.
    // Skip leading coords that would create a backward step relative
    // to the overall travel direction from the segment's last point.
    let startIdx = 0;
    if (segCoords.length > 0 && segCoords.length >= 2) {
      const lastC = segCoords[segCoords.length - 1];
      const prevC = segCoords[segCoords.length - 2];
      const prevBearing = Math.atan2(
        lastC[0] - prevC[0], lastC[1] - prevC[1]
      );

      // Skip coords that are near-duplicates
      while (startIdx < pc.coords.length - 1 &&
             haversineM(lastC, pc.coords[startIdx]) < 1) {
        startIdx++;
      }

      // Skip the first non-duplicate coord if it creates a >120° bearing
      // change AND there's a subsequent coord that doesn't
      if (startIdx < pc.coords.length - 1) {
        const bearing1 = Math.atan2(
          pc.coords[startIdx][0] - lastC[0],
          pc.coords[startIdx][1] - lastC[1]
        );
        let df = Math.abs(bearing1 - prevBearing);
        if (df > Math.PI) df = 2 * Math.PI - df;

        if (df > 2 * Math.PI / 3) {
          // This coord would cause a reversal — check if skipping it helps
          const bearing2 = Math.atan2(
            pc.coords[startIdx + 1][0] - lastC[0],
            pc.coords[startIdx + 1][1] - lastC[1]
          );
          let df2 = Math.abs(bearing2 - prevBearing);
          if (df2 > Math.PI) df2 = 2 * Math.PI - df2;

          if (df2 < df) {
            startIdx++; // skip the reversal-causing point
          }
        }
      }
    } else if (segCoords.length > 0) {
      const lastC = segCoords[segCoords.length - 1];
      while (startIdx < pc.coords.length - 1 &&
             haversineM(lastC, pc.coords[startIdx]) < 1) {
        startIdx++;
      }
    }

    const geom = [];
    for (let i = startIdx; i < pc.coords.length; i++) {
      const c = pc.coords[i];
      // Skip if very close to the previous point in geom
      if (geom.length > 0 && haversineM(geom[geom.length - 1], c) < 0.5) continue;
      geom.push(c);
    }

    if (geom.length < 1) continue;

    seg.push({
      id: pc.id,
      geometry: geom.map(c => ({ lon: c[0], lat: c[1] })),
      _reversed: pc.reversed,
    });

    for (const c of geom) segCoords.push(c);
  }

  return segments.length > 0 ? segments : [[]];
}
