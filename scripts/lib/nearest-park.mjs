/**
 * Geometry-to-geometry distance utilities for naming unnamed chains.
 * Used by the pipeline and by tests — same function, same answer.
 */

/**
 * Minimum distance in metres between two sets of points.
 * @param {Array<{lat: number, lon: number}>} geomA
 * @param {Array<{lat: number, lon: number}>} geomB
 * @returns {number} distance in metres
 */
export function minGeomDist(geomA, geomB) {
  let min = Infinity;
  for (const a of geomA) {
    for (const b of geomB) {
      if (!b.lat) continue;
      const dlat = (a.lat - b.lat) * 111320;
      const dlng = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
      const d = dlat * dlat + dlng * dlng;
      if (d < min) min = d;
    }
  }
  return Math.sqrt(min);
}

/**
 * Rank Overpass elements by minimum geometry-to-geometry distance to a chain.
 * Works for parks, roads, or any features with .geometry and .tags.name.
 * @param {Array<{lat: number, lon: number}>} chainPts - all points from the chain's ways
 * @param {Array<object>} elements - Overpass elements with .geometry and .tags.name
 * @returns {Array<{name: string, dist: number}>} sorted closest-first
 */
export function rankByGeomDistance(chainPts, elements) {
  const ranked = elements
    .filter(el => el.geometry?.length > 0 || el.members)
    .map(el => {
      const coords = el.geometry || el.members?.flatMap(m => m.geometry || []) || [];
      return { name: el.tags?.name, dist: minGeomDist(chainPts, coords) };
    });
  ranked.sort((a, b) => a.dist - b.dist);
  return ranked;
}

// Keep old name as alias for tests that already import it
export const rankParksByGeomDistance = rankByGeomDistance;
