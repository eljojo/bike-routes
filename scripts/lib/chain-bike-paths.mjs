/**
 * Chain a mixed list of waypoints (places and bike paths) into a segmented
 * GPX trace. Each bike path is trimmed to the section relevant to the route,
 * oriented correctly, and consecutive paths within 200m are merged into one
 * segment.
 *
 * Returns ORIGINAL OSM ways (not synthetic polylines). The measured polyline
 * is used only to compute scalar boundaries — the output preserves the
 * original way structure.
 *
 * @param {Array} waypoints - mixed: { lat, lng } places and Array<way> bike paths
 * @returns {Array<Array<way>>} segments, each an array of oriented ways
 */

import { haversineM, nearestPointOnPolyline } from './geo.mjs';

function isPlace(wp) {
  return !Array.isArray(wp) && wp.lat != null && wp.lng != null;
}

/**
 * Build a measured polyline from ordered ways.
 * Returns { coords, cumDist, wayBounds } where wayBounds[i] = { startScalar, endScalar }
 * for each input way.
 */
function buildMeasuredPoly(ways) {
  const coords = [];
  const cumDist = [];
  const wayBounds = []; // { startScalar, endScalar } per way
  let dist = 0;

  for (let w = 0; w < ways.length; w++) {
    const g = ways[w].geometry;
    // Apply _reversed so the measured poly follows the RENDERED direction.
    // This way, projecting a place onto the poly gives a scalar in the
    // rendered coordinate space, and forward/backward in sliceWays
    // correctly maps to the rendered direction.
    const points = ways[w]._reversed
      ? [...g].reverse()
      : g;
    const startScalar = dist;
    for (let p = 0; p < points.length; p++) {
      const c = [points[p].lon, points[p].lat];
      if (coords.length > 0) {
        dist += haversineM(coords[coords.length - 1], c);
      }
      coords.push(c);
      cumDist.push(dist);
    }
    wayBounds.push({ startScalar, endScalar: dist });
  }

  return { coords, cumDist, totalLength: dist, wayBounds };
}

/**
 * Closest pair between two measured polylines.
 * Samples points along each, projects onto the other.
 *
 * Tie-break strategy:
 * - For non-overlapping paths (minDist > 200m): prefer B entry nearest an endpoint
 * - For overlapping paths (minDist ≤ 200m): maximize A's scalar (exit A late)
 *   so each path covers its unique section before handing off to the next.
 */
function closestPair(polyA, polyB) {
  let minDist = Infinity;
  const candidates = [];

  // Sample A → project onto B
  const stepA = Math.max(1, Math.floor(polyA.coords.length / 80));
  for (let i = 0; i < polyA.coords.length; i += stepA) {
    const proj = nearestPointOnPolyline(polyA.coords[i], polyB.coords);
    candidates.push({ scalarA: polyA.cumDist[i], scalarB: proj.scalar, dist: proj.dist });
    if (proj.dist < minDist) minDist = proj.dist;
  }

  // Sample B → project onto A
  const stepB = Math.max(1, Math.floor(polyB.coords.length / 80));
  for (let i = 0; i < polyB.coords.length; i += stepB) {
    const proj = nearestPointOnPolyline(polyB.coords[i], polyA.coords);
    candidates.push({ scalarA: proj.scalar, scalarB: polyB.cumDist[i], dist: proj.dist });
    if (proj.dist < minDist) minDist = proj.dist;
  }

  const threshold = Math.max(minDist * 1.1, minDist + 50);
  const near = candidates.filter(c => c.dist <= threshold);

  let best = near[0];

  // Detect overlapping paths: many candidates with very small distance means
  // the paths run alongside each other, not just meet at one junction.
  const closeCount = candidates.filter(c => c.dist < 100).length;
  const isOverlapping = minDist < 100 && closeCount > candidates.length * 0.3;

  if (isOverlapping) {
    // Overlapping paths: find the midpoint of the overlap zone.
    // Don't maximize or minimize either path — split the overlap fairly
    // so direction correction can decide which section each path covers.
    let minScalarA = Infinity, maxScalarA = -Infinity;
    for (const c of near) {
      if (c.scalarA < minScalarA) minScalarA = c.scalarA;
      if (c.scalarA > maxScalarA) maxScalarA = c.scalarA;
    }
    const midScalarA = (minScalarA + maxScalarA) / 2;
    let bestDiff = Infinity;
    for (const c of near) {
      const diff = Math.abs(c.scalarA - midScalarA);
      if (diff < bestDiff) { bestDiff = diff; best = c; }
    }
  } else {
    // Non-overlapping: prefer B entry nearest an endpoint
    let bestEndDist = Math.min(best.scalarB, polyB.totalLength - best.scalarB);
    for (const c of near) {
      const ed = Math.min(c.scalarB, polyB.totalLength - c.scalarB);
      if (ed < bestEndDist) { bestEndDist = ed; best = c; }
    }
  }

  return best;
}

/**
 * Given entry/exit scalars on a measured polyline, return the original ways
 * that overlap the interval, in the correct traversal order.
 */
function sliceWays(ways, poly, entryScalar, exitScalar) {
  const forward = entryScalar <= exitScalar;
  const lo = Math.min(entryScalar, exitScalar);
  const hi = Math.max(entryScalar, exitScalar);

  // Find ways overlapping the interval
  const included = [];
  for (let w = 0; w < ways.length; w++) {
    const wb = poly.wayBounds[w];
    if (wb.endScalar >= lo && wb.startScalar <= hi) {
      included.push(w);
    }
  }

  // Reverse order if traversing backward
  if (!forward) included.reverse();

  return included.map(w => {
    const way = { ...ways[w] };
    // The measured poly is built in RENDERED direction (applying _reversed).
    // Forward = render in poly direction = keep _reversed as-is.
    // Backward = render against poly direction = flip _reversed.
    way._reversed = forward ? (way._reversed || false) : !way._reversed;
    return way;
  });
}

/**
 * Get the geographic coordinate at entry/exit of a sliced path.
 */
function coordAtScalar(poly, scalar) {
  const s = Math.max(0, Math.min(scalar, poly.totalLength));
  for (let i = 1; i < poly.coords.length; i++) {
    if (poly.cumDist[i] >= s - 0.01) {
      const prev = poly.cumDist[i - 1];
      const segLen = poly.cumDist[i] - prev;
      const t = segLen > 0 ? (s - prev) / segLen : 0;
      return [
        poly.coords[i - 1][0] + t * (poly.coords[i][0] - poly.coords[i - 1][0]),
        poly.coords[i - 1][1] + t * (poly.coords[i][1] - poly.coords[i - 1][1]),
      ];
    }
  }
  return poly.coords[poly.coords.length - 1];
}

const SEGMENT_BREAK_M = 200;

export function chainBikePaths(waypoints) {
  if (waypoints.length === 0) return [[]];

  // Classify waypoints
  const items = waypoints.map(wp => {
    if (isPlace(wp)) return { type: 'place', coord: [wp.lng, wp.lat] };
    if (Array.isArray(wp)) {
      const poly = buildMeasuredPoly(wp);
      return { type: 'path', ways: wp, poly, entry: null, exit: null };
    }
    return { type: 'unknown' };
  });

  // Solve boundaries left-to-right
  for (let i = 0; i < items.length - 1; i++) {
    const a = items[i];
    const b = items[i + 1];

    if (a.type === 'place' && b.type === 'path') {
      const proj = nearestPointOnPolyline(a.coord, b.poly.coords);
      b.entry = proj.scalar;
    } else if (a.type === 'path' && b.type === 'place') {
      const proj = nearestPointOnPolyline(b.coord, a.poly.coords);
      a.exit = proj.scalar;
    } else if (a.type === 'path' && b.type === 'path') {
      const pair = closestPair(a.poly, b.poly);
      a.exit = pair.scalarA;
      b.entry = pair.scalarB;
    }
  }

  // Direction correction: when a path is bracketed by places (or other paths),
  // ensure the entry→exit scalar direction matches the travel direction.
  // If the previous waypoint is EAST and the next is WEST, but entry < exit
  // on a W→E polyline, swap entry and exit to force backward traversal.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== 'path') continue;
    if (item.entry === null || item.exit === null) continue;

    // Find previous and next coordinates
    let prevCoord = null, nextCoord = null;
    for (let p = i - 1; p >= 0; p--) {
      if (items[p].type === 'place') { prevCoord = items[p].coord; break; }
      if (items[p].type === 'path' && items[p].exit != null) {
        prevCoord = coordAtScalar(items[p].poly, items[p].exit);
        break;
      }
    }
    for (let n = i + 1; n < items.length; n++) {
      if (items[n].type === 'place') { nextCoord = items[n].coord; break; }
      if (items[n].type === 'path' && items[n].entry != null) {
        nextCoord = coordAtScalar(items[n].poly, items[n].entry);
        break;
      }
    }

    if (!prevCoord || !nextCoord) continue;

    // Check: does the current entry→exit go the right way?
    // Entry should be closer to prevCoord, exit closer to nextCoord.
    const entryCoord = coordAtScalar(item.poly, item.entry);
    const exitCoord = coordAtScalar(item.poly, item.exit);

    const entryToPrev = haversineM(entryCoord, prevCoord);
    const exitToPrev = haversineM(exitCoord, prevCoord);
    const entryToNext = haversineM(entryCoord, nextCoord);
    const exitToNext = haversineM(exitCoord, nextCoord);

    // If exit is closer to prev than entry, and entry is closer to next than exit,
    // the path is going the wrong way. Swap.
    if (exitToPrev < entryToPrev && entryToNext < exitToNext) {
      [item.entry, item.exit] = [item.exit, item.entry];
    }
  }

  // Resolve unconstrained boundaries.
  // For first/last paths, use the travel direction from neighboring waypoints
  // to pick the right endpoint, not just "farthest from entry/exit".
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (item.type !== 'path') continue;
    const L = item.poly.totalLength;

    if (item.entry === null && item.exit !== null) {
      // First path: pick the endpoint on the OPPOSITE side of exit
      // so the path goes toward the exit. "Farthest from exit" is correct here.
      item.entry = Math.abs(item.exit - 0) >= Math.abs(item.exit - L) ? 0 : L;
    }
    if (item.exit === null && item.entry !== null) {
      // Last path: continue travel direction established by previous paths.
      // Find the previous waypoint's exit to determine travel direction.
      let prevCoord = null;
      for (let p = idx - 1; p >= 0; p--) {
        if (items[p].type === 'place') { prevCoord = items[p].coord; break; }
        if (items[p].type === 'path' && items[p].exit != null) {
          prevCoord = coordAtScalar(items[p].poly, items[p].exit);
          break;
        }
      }
      if (prevCoord) {
        // The entry point on this path is where we arrive from the previous path.
        // The travel direction goes FROM prevCoord TOWARD entry.
        // Continue that direction: pick the exit that is farther from prevCoord
        // than the entry is (i.e., continue past the entry in the same direction).
        const entryCoord = coordAtScalar(item.poly, item.entry);
        const coordAt0 = coordAtScalar(item.poly, 0);
        const coordAtL = coordAtScalar(item.poly, L);
        const entryDist = haversineM(prevCoord, entryCoord);
        const d0 = haversineM(prevCoord, coordAt0);
        const dL = haversineM(prevCoord, coordAtL);
        // Pick the endpoint that goes FURTHER from prevCoord than the entry
        // If both are farther, pick the one farthest. If neither, pick closer to entry.
        if (d0 > entryDist && dL > entryDist) {
          item.exit = d0 >= dL ? 0 : L;
        } else if (d0 > entryDist) {
          item.exit = 0;
        } else if (dL > entryDist) {
          item.exit = L;
        } else {
          // Neither endpoint is farther than entry — entry is at or beyond
          // the path's extent. Use the nearest endpoint (small section).
          item.exit = Math.abs(item.entry - 0) < Math.abs(item.entry - L) ? 0 : L;
        }
      } else {
        item.exit = Math.abs(item.entry - 0) >= Math.abs(item.entry - L) ? 0 : L;
      }
    }
    if (item.entry === null && item.exit === null) {
      item.entry = 0;
      item.exit = L;
    }
  }

  // Trim each path and collect into segments
  const segments = [];
  let currentSegment = [];
  let lastExitCoord = null;

  for (const item of items) {
    if (item.type !== 'path') continue;

    const trimmed = sliceWays(item.ways, item.poly, item.entry, item.exit);
    if (trimmed.length === 0) continue;

    // Check if this connects to the previous segment
    const entryCoord = coordAtScalar(item.poly, item.entry);
    if (lastExitCoord && haversineM(lastExitCoord, entryCoord) > SEGMENT_BREAK_M) {
      if (currentSegment.length > 0) segments.push(currentSegment);
      currentSegment = [];
    }

    currentSegment.push(...trimmed);
    lastExitCoord = coordAtScalar(item.poly, item.exit);
  }

  if (currentSegment.length > 0) segments.push(currentSegment);

  // Remove backtracking overlaps within segments.
  // When overlapping paths are merged, consecutive ways may start BEHIND
  // the previous way's end (e.g., way A ends at lat -33.464, way B starts
  // at lat -33.465 going the same direction). Drop the backtracking portion.
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (seg.length < 2) continue;

    // Determine overall direction from first and last rendered points
    const firstWay = seg[0];
    const lastWay = seg[seg.length - 1];
    const fc = firstWay.geometry;
    const lc = lastWay.geometry;
    const startPt = firstWay._reversed ? fc[fc.length - 1] : fc[0];
    const endPt = lastWay._reversed ? lc[0] : lc[lc.length - 1];
    const overallDlat = endPt.lat - startPt.lat;
    const overallDlng = endPt.lon - startPt.lon;
    // Only apply to predominantly N-S segments (lat component > lng component)
    if (Math.abs(overallDlat) < Math.abs(overallDlng)) continue;
    if (Math.abs(overallDlat) < 0.001) continue;

    const goingNorth = overallDlat > 0;
    const filtered = [seg[0]];

    for (let w = 1; w < seg.length; w++) {
      const prevWay = filtered[filtered.length - 1];
      const curWay = seg[w];

      // Get the rendered end of previous and rendered start of current
      const pg = prevWay.geometry;
      const prevEnd = prevWay._reversed ? pg[0] : pg[pg.length - 1];
      const cg = curWay.geometry;
      const curStart = curWay._reversed ? cg[cg.length - 1] : cg[0];

      // If current way starts behind previous way's end (against direction),
      // check if the overlap is significant (>100m)
      const backtrackM = goingNorth
        ? (prevEnd.lat - curStart.lat) * 111000  // going north: backtrack = start is south of end
        : (curStart.lat - prevEnd.lat) * 111000; // going south: backtrack = start is north of end

      if (backtrackM > 100 && !curWay._connector) {
        // Skip this way — it backtracks against the travel direction
        // (but never skip deliberately-inserted connector ways)
        continue;
      }

      filtered.push(curWay);
    }

    segments[s] = filtered;
  }

  return segments.length > 0 ? segments : [[]];
}
