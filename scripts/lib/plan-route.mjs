import { haversineM } from './geo.mjs';
import { scoreRoute } from './score-route.mjs';

/**
 * Build a flat coordinate array from ordered ways.
 */
function waysToCoords(ways) {
  const coords = [];
  for (const w of ways) {
    for (const p of w.geometry) {
      coords.push([p.lon, p.lat]);
    }
  }
  return coords;
}

/**
 * Check if a bike path is within bufferM of the corridor between two points.
 * Samples ~20 evenly-spaced points along the path (plus the last point)
 * against a circle centered on the corridor midpoint with radius =
 * half corridor length + buffer.
 */
function pathNearCorridor(from, to, ways, bufferM = 2000) {
  const coords = waysToCoords(ways);
  if (coords.length === 0) return false;
  const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const corridorLen = haversineM(from, to);
  const maxDist = corridorLen / 2 + bufferM;

  // Sample every ~20 points along the path (not just 3)
  const step = Math.max(1, Math.floor(coords.length / 20));
  for (let i = 0; i < coords.length; i += step) {
    if (haversineM(mid, coords[i]) < maxDist) return true;
  }
  // Always check last point
  if (haversineM(mid, coords[coords.length - 1]) < maxDist) return true;
  return false;
}

/**
 * Find bike paths that could connect two places.
 *
 * @param {[number,number]} from - [lng, lat]
 * @param {[number,number]} to - [lng, lat]
 * @param {Array<{ slug: string, ways: Array<way> }>} allPaths
 * @param {Object} [options]
 * @param {number} [options.bufferM=2000]
 * @param {Array} [options.places] - for amenity scoring
 * @returns {Array<{ slug, ways, score }>} sorted best-first
 */
export function findCandidatePaths(from, to, allPaths, options = {}) {
  const { bufferM = 2000, places = [] } = options;

  const candidates = [];
  for (const bp of allPaths) {
    if (!bp.ways || bp.ways.length === 0) continue;
    if (!pathNearCorridor(from, to, bp.ways, bufferM)) continue;

    const score = scoreRoute(bp.ways, from, to, { places });
    candidates.push({ slug: bp.slug, ways: bp.ways, score });
  }

  candidates.sort((a, b) => b.score.total - a.score.total);
  return candidates;
}

/**
 * Given a classified waypoint list, detect gaps between consecutive non-path
 * waypoints and fill them with the best available bike paths.
 *
 * @param {Array<{ type: 'place'|'path', coord?: [number,number], ways?: Array<way> }>} waypoints
 * @param {Array<{ slug: string, ways: Array<way> }>} allPaths
 * @param {Object} [options]
 * @returns {Array} - mixed: place objects { lat, lng } and way arrays, ready for chainBikePaths
 */
/**
 * Find the nearest point on a path's geometry to a given coordinate.
 * Returns the distance in metres.
 */
function pathDistTo(ways, coord) {
  let minD = Infinity;
  for (const w of ways) {
    for (const p of w.geometry) {
      const d = haversineM(coord, [p.lon, p.lat]);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

/**
 * Find the coordinate on a path closest to a given point (for greedy chaining).
 */
function nearestCoordOnPath(ways, coord) {
  let minD = Infinity;
  let best = coord;
  for (const w of ways) {
    for (const p of w.geometry) {
      const c = [p.lon, p.lat];
      const d = haversineM(coord, c);
      if (d < minD) { minD = d; best = c; }
    }
  }
  return best;
}

export function planRoute(waypoints, allPaths, options = {}) {
  const result = [];
  const usedSlugs = new Set(); // Don't reuse paths

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    result.push(wp.type === 'path' ? wp.ways : { lat: wp.coord[1], lng: wp.coord[0] });

    // Check for gap: current is non-path AND next is non-path
    if (wp.type === 'place' && i + 1 < waypoints.length && waypoints[i + 1].type === 'place') {
      const from = wp.coord;
      const to = waypoints[i + 1].coord;
      const gapDist = haversineM(from, to);

      // Filter out already-used paths
      const available = allPaths.filter(p => !usedSlugs.has(p.slug));

      // Try to fill the gap — may need multiple paths (greedy chaining)
      const filled = fillGap(from, to, available, options);
      for (const selected of filled) {
        result.push(selected.ways);
        usedSlugs.add(selected.slug);
      }
    }
  }

  return result;
}

/**
 * Fill a gap between two coordinates with one or more bike paths.
 * Uses greedy chaining: pick the best path from `from`, advance to its
 * exit point, repeat until we reach `to` or run out of candidates.
 *
 * @returns {Array<{ slug, ways }>} selected paths in order
 */
function fillGap(from, to, available, options = {}, maxChain = 3) {
  const selected = [];
  const used = new Set();
  let current = from;

  for (let step = 0; step < maxChain; step++) {
    const remaining = available.filter(p => !used.has(p.slug));
    const candidates = findCandidatePaths(current, to, remaining, options);
    if (candidates.length === 0) break;

    const best = candidates[0];
    selected.push(best);
    used.add(best.slug);

    // Advance current position to the path's point closest to `to`
    const exitCoord = nearestCoordOnPath(best.ways, to);
    const distToGoal = haversineM(exitCoord, to);

    // If we're within 2km of the destination, stop chaining
    if (distToGoal < 2000) break;

    // Otherwise, continue from the exit point
    current = exitCoord;
  }

  return selected;
}
