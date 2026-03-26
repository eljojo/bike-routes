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
 * Checks start, midpoint, and end of the path against a circle centered on
 * the corridor midpoint with radius = half corridor length + buffer.
 */
function pathNearCorridor(from, to, ways, bufferM = 2000) {
  const coords = waysToCoords(ways);
  if (coords.length === 0) return false;
  const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  const corridorLen = haversineM(from, to);
  const maxDist = corridorLen / 2 + bufferM;
  for (const c of [coords[0], coords[Math.floor(coords.length / 2)], coords[coords.length - 1]]) {
    if (haversineM(mid, c) < maxDist) return true;
  }
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
export function planRoute(waypoints, allPaths, options = {}) {
  const result = [];

  for (let i = 0; i < waypoints.length; i++) {
    const wp = waypoints[i];
    result.push(wp.type === 'path' ? wp.ways : { lat: wp.coord[1], lng: wp.coord[0] });

    // Check for gap: current is non-path AND next is non-path
    if (wp.type === 'place' && i + 1 < waypoints.length && waypoints[i + 1].type === 'place') {
      const from = wp.coord;
      const to = waypoints[i + 1].coord;
      const candidates = findCandidatePaths(from, to, allPaths, options);
      if (candidates.length > 0) {
        result.push(candidates[0].ways);
      }
    }
  }

  return result;
}
