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
    // Non-overlapping: use the closest pair (minimum distance).
    // Don't prefer endpoints — that can set entry at the far end of a
    // long path, causing the entire path to be included when only a
    // section near the junction is needed.
    for (const c of near) {
      if (c.dist < best.dist) best = c;
    }
  }

  return best;
}

/**
 * Given entry/exit scalars on a measured polyline, return the original ways
 * that overlap the interval, in the correct traversal order.
 * Boundary ways are trimmed to the entry/exit scalar cut points so they
 * don't extend beyond the needed section.
 */
function sliceWays(ways, poly, entryScalar, exitScalar) {
  const forward = entryScalar <= exitScalar;
  const lo = Math.min(entryScalar, exitScalar);
  const hi = Math.max(entryScalar, exitScalar);

  // Find ways overlapping the interval.
  // Skip boundary ways that barely overlap — they extend mostly outside
  // the needed section and can cause zigzag in adjacent paths' zones.
  const included = [];
  for (let w = 0; w < ways.length; w++) {
    const wb = poly.wayBounds[w];
    if (wb.endScalar < lo || wb.startScalar > hi) continue;
    const wayLen = wb.endScalar - wb.startScalar;
    const overlapLo = Math.max(lo, wb.startScalar);
    const overlapHi = Math.min(hi, wb.endScalar);
    const overlapLen = overlapHi - overlapLo;
    // Drop ways that barely overlap.
    // OSM-name-resolved paths (streets found via queryOsmName) need
    // stricter filtering because they often extend far beyond the
    // needed section. Regular bikepaths.yml paths use a lenient threshold.
    if (wayLen > 100 && overlapLen / wayLen < 0.2) continue;
    included.push(w);
  }

  // Reverse order if traversing backward
  if (!forward) included.reverse();

  return included.map(w => {
    const way = { ...ways[w] };
    // The measured poly is built in RENDERED direction (applying _reversed).
    // Forward = render in poly direction = keep _reversed as-is.
    // Backward = render against poly direction = flip _reversed.
    way._reversed = forward ? (way._reversed || false) : !way._reversed;

    // Trim boundary ways for OSM-name-resolved paths only.
    // These paths (from queryOsmName) extend far beyond the needed section.
    // Regular bikepaths.yml paths keep full boundary ways for coverage.
    if (ways[w]._osmNameResolved) {
      const isFirstInSlice = (included.indexOf(w) === 0);
      const isLastInSlice = (included.indexOf(w) === included.length - 1);
      if (isFirstInSlice || isLastInSlice) {
        const wb = poly.wayBounds[w];
        const wayLo = Math.max(lo, wb.startScalar);
        const wayHi = Math.min(hi, wb.endScalar);
        if (wayLo > wb.startScalar || wayHi < wb.endScalar) {
          const origG = ways[w].geometry;
          const rendered = ways[w]._reversed ? [...origG].reverse() : origG;
          const dists = [0];
          for (let p = 1; p < rendered.length; p++) {
            dists.push(dists[p - 1] + haversineM(
              [rendered[p - 1].lon, rendered[p - 1].lat],
              [rendered[p].lon, rendered[p].lat]
            ));
          }
          const trimStart = wayLo - wb.startScalar;
          const trimEnd = wayHi - wb.startScalar;
          const keptRendered = [];
          for (let p = 0; p < rendered.length; p++) {
            if (dists[p] >= trimStart - 1 && dists[p] <= trimEnd + 1) {
              keptRendered.push(rendered[p]);
            }
          }
          if (keptRendered.length >= 2) {
            way.geometry = ways[w]._reversed ? [...keptRendered].reverse() : keptRendered;
          }
        }
      }
    }

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

  // Tighten OSM-name-resolved paths: their entry/exit may span the entire
  // path when only a section is needed. Project the neighboring waypoints
  // onto the path and constrain entry/exit to not extend beyond them plus
  // a small margin. This prevents e.g., LTO from including its southern
  // ways that overlap with Pocuro's zone.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== 'path') continue;
    if (!item.ways.some(w => w._osmNameResolved)) continue;
    if (item.entry === null || item.exit === null) continue;

    // Find neighboring coordinates
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

    // For OSM-name paths, constrain to the section between neighboring
    // PLACE waypoints (not path waypoints). Path neighbors project onto
    // LTO at the wrong end; place neighbors give the actual transition point.
    // Use a 300m margin to allow for connection gaps.
    const placePrev = (() => {
      for (let p = i - 1; p >= 0; p--) {
        if (items[p].type === 'place') return items[p].coord;
      }
      return null;
    })();
    const placeNext = (() => {
      for (let n = i + 1; n < items.length; n++) {
        if (items[n].type === 'place') return items[n].coord;
      }
      return null;
    })();
    if (placeNext) {
      const nextProj = nearestPointOnPolyline(placeNext, item.poly.coords);
      // Constrain around the next place: the path is used to get TO this place.
      // Use a generous margin in the approach direction.
      const projCenter = nextProj.scalar;
      const margin = 800; // 800m around the next place
      const projLo = projCenter;
      const projHi = projCenter;
      const tightLo = Math.max(0, projLo - margin);
      const tightHi = Math.min(item.poly.totalLength, projHi + margin);
      const lo = Math.min(item.entry, item.exit);
      const hi = Math.max(item.entry, item.exit);
      const newLo = Math.max(lo, tightLo);
      const newHi = Math.min(hi, tightHi);
      if (item.entry <= item.exit) {
        item.entry = newLo;
        item.exit = newHi;
      } else {
        item.entry = newHi;
        item.exit = newLo;
      }
    }
  }

  // Trim each path and collect into segments.
  // Tag each way with _pathIdx so backtrack removal only applies within
  // the same source path (not across path transitions like Pocuro → LTO).
  const segments = [];
  let currentSegment = [];
  let lastExitCoord = null;
  let pathIdx = 0;
  const pathItems = items.filter(it => it.type === 'path');

  for (const item of items) {
    if (item.type !== 'path') continue;

    const trimmed = sliceWays(item.ways, item.poly, item.entry, item.exit);
    if (trimmed.length === 0) { pathIdx++; continue; }

    // Check if this connects to the previous segment
    const entryCoord = coordAtScalar(item.poly, item.entry);
    if (lastExitCoord && haversineM(lastExitCoord, entryCoord) > SEGMENT_BREAK_M) {
      if (currentSegment.length > 0) segments.push(currentSegment);
      currentSegment = [];
    }

    for (const w of trimmed) w._pathIdx = pathIdx;
    currentSegment.push(...trimmed);
    lastExitCoord = coordAtScalar(item.poly, item.exit);
    pathIdx++;
  }

  if (currentSegment.length > 0) segments.push(currentSegment);

  // Deduplicate ways with the same OSM id across the entire segment.
  // When overlapping bike paths share underlying OSM ways (e.g., pocuro
  // appears in both ciclovia-pocuro and ciclovia-sanchez-fontecilla),
  // keep only the first occurrence. This prevents the same corridor from
  // being rendered twice, which causes zigzag artifacts.
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    if (seg.length < 2) continue;
    const deduped = [seg[0]];
    const seen = new Set([seg[0].id]);
    // Track rendered corridor coverage for geography-based dedup
    const coveredCorridors = []; // [{midLng, midLat, bearing}]
    {
      const g0 = seg[0].geometry;
      const s0 = seg[0]._reversed ? g0[g0.length - 1] : g0[0];
      const e0 = seg[0]._reversed ? g0[0] : g0[g0.length - 1];
      coveredCorridors.push({
        midLng: (s0.lon + e0.lon) / 2, midLat: (s0.lat + e0.lat) / 2,
        bearing: Math.atan2(e0.lon - s0.lon, e0.lat - s0.lat),
      });
    }
    for (let w = 1; w < seg.length; w++) {
      const way = seg[w];
      // ID-based dedup
      if (seen.has(way.id)) continue;

      // Geography-based dedup: if this way covers the same corridor as
      // a previously rendered way (midpoints within 150m, similar bearing),
      // it's a duplicate from a different OSM relation. Drop it.
      const g = way.geometry;
      const ws = way._reversed ? g[g.length - 1] : g[0];
      const we = way._reversed ? g[0] : g[g.length - 1];
      const midLng = (ws.lon + we.lon) / 2;
      const midLat = (ws.lat + we.lat) / 2;
      const bearing = Math.atan2(we.lon - ws.lon, we.lat - ws.lat);
      let isGeoDup = false;
      for (const c of coveredCorridors) {
        const dist = haversineM([midLng, midLat], [c.midLng, c.midLat]);
        if (dist > 150) continue;
        let bDiff = Math.abs(bearing - c.bearing);
        if (bDiff > Math.PI) bDiff = 2 * Math.PI - bDiff;
        // Similar or anti-parallel bearing (same corridor, either direction).
        // Use a generous 60° threshold to catch diagonal overlaps
        // (e.g., NW sánchez fontecilla overlapping W pocuro).
        if (bDiff < Math.PI / 3 || bDiff > 2 * Math.PI / 3) {
          isGeoDup = true;
          break;
        }
      }
      if (isGeoDup) continue;

      seen.add(way.id);
      coveredCorridors.push({ midLng, midLat, bearing });
      deduped.push(way);
    }
    segments[s] = deduped;
  }

  // Split segments at large gaps between consecutive rendered ways.
  // closestPair can find junctions where polylines are close but the actual
  // rendered way endpoints are far apart (e.g., Pocuro and LTO: polylines
  // meet at a projected point but the ways are 1.6km apart). Split these
  // into separate segments.
  const RENDERED_GAP_M = 1000;
  for (let s = segments.length - 1; s >= 0; s--) {
    const seg = segments[s];
    if (seg.length < 2) continue;
    for (let w = 1; w < seg.length; w++) {
      const prevWay = seg[w - 1];
      const curWay = seg[w];
      const pg = prevWay.geometry;
      const cg = curWay.geometry;
      const prevEnd = prevWay._reversed ? pg[0] : pg[pg.length - 1];
      const curStart = curWay._reversed ? cg[cg.length - 1] : cg[0];
      const gap = haversineM([prevEnd.lon, prevEnd.lat], [curStart.lon, curStart.lat]);
      if (gap > RENDERED_GAP_M && prevWay._pathIdx != null && curWay._pathIdx != null
          && prevWay._pathIdx !== curWay._pathIdx) {
        // Split: seg[0..w-1] and seg[w..end]
        const before = seg.slice(0, w);
        const after = seg.slice(w);
        segments.splice(s, 1, before, after);
        break; // restart from the new segments
      }
    }
  }

  // Remove backtracking overlaps within segments.
  // When overlapping paths are merged, consecutive ways may start BEHIND
  // the previous way's end. Drop the backtracking portion.
  // Works for both N-S and E-W dominant segments.
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

    const isNS = Math.abs(overallDlat) >= Math.abs(overallDlng);
    // Need at least some movement to detect backtracking
    if (isNS && Math.abs(overallDlat) < 0.001) continue;
    if (!isNS && Math.abs(overallDlng) < 0.001) continue;

    const filtered = [seg[0]];

    for (let w = 1; w < seg.length; w++) {
      const prevWay = filtered[filtered.length - 1];
      const curWay = seg[w];

      // Get the rendered end of previous and rendered start of current
      const pg = prevWay.geometry;
      const prevEnd = prevWay._reversed ? pg[0] : pg[pg.length - 1];
      const cg = curWay.geometry;
      const curStart = curWay._reversed ? cg[cg.length - 1] : cg[0];

      let backtrackM;
      if (isNS) {
        const goingNorth = overallDlat > 0;
        backtrackM = goingNorth
          ? (prevEnd.lat - curStart.lat) * 111000
          : (curStart.lat - prevEnd.lat) * 111000;
      } else {
        const goingEast = overallDlng > 0;
        // lng degrees ≈ 85km at Santiago's latitude (-33°)
        backtrackM = goingEast
          ? (prevEnd.lon - curStart.lon) * 85000
          : (curStart.lon - prevEnd.lon) * 85000;
      }

      if (backtrackM > 100) {
        // Always drop same-path backtracks. For cross-path backtracks,
        // only drop if the way re-enters an already-covered corridor
        // (same OSM id as a previously rendered way). A new corridor
        // entering from a different direction (e.g., LTO going N-S after
        // Pocuro going E-W) is a legitimate transition, not a backtrack.
        if (curWay._pathIdx === prevWay._pathIdx) {
          continue; // same source path — definitely backtracking
        }
        // Cross-path: check if this way's OSM id was already seen
        const alreadySeen = filtered.some(fw => fw.id === curWay.id);
        if (alreadySeen) {
          continue; // re-entering an already-covered corridor
        }
      }

      filtered.push(curWay);
    }

    segments[s] = filtered;
  }

  return segments.length > 0 ? segments : [[]];
}
