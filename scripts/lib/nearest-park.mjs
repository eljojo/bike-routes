/**
 * Find the nearest park to a chain of ways by real geometry-to-geometry distance.
 * Used by the pipeline for naming unnamed chains, and by tests to verify correctness.
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
 * Rank park candidates by minimum geometry-to-geometry distance to a chain.
 * @param {Array<{lat: number, lon: number}>} chainPts - all points from the chain's ways
 * @param {Array<object>} parkElements - Overpass elements with .geometry and .tags.name
 * @returns {Array<{name: string, dist: number}>} sorted closest-first
 */
export function rankParksByGeomDistance(chainPts, parkElements) {
  const ranked = parkElements
    .filter(el => el.geometry?.length > 0 || el.members)
    .map(el => {
      const parkCoords = el.geometry || el.members?.flatMap(m => m.geometry || []) || [];
      return { name: el.tags?.name, dist: minGeomDist(chainPts, parkCoords) };
    });
  ranked.sort((a, b) => a.dist - b.dist);
  return ranked;
}
