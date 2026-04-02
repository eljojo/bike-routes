// park-containment.mjs
//
// Determine which park each trail belongs to using actual trail geometry.
// NOT centroids, NOT single points — multiple sampled points along the
// trail with majority-wins classification.
//
// This replaces the centroid-based is_in naming that caused Gatineau Park
// trails to be assigned to the Greenbelt network. A trail's park is a
// spatial fact determined by where the trail physically is, not by where
// the center of its cluster happens to fall.

/**
 * Ray-casting point-in-polygon test.
 * @param {{ lat: number, lon: number }} point
 * @param {Array<{ lat: number, lon: number }>} polygon — closed ring
 * @returns {boolean}
 */
export function pointInPolygon(point, polygon) {
  const { lat, lon } = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i].lat, xi = polygon[i].lon;
    const yj = polygon[j].lat, xj = polygon[j].lon;
    if (((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Sample representative points from a trail's _ways geometry.
 * Takes every Nth point to keep the count manageable while covering
 * the trail's full extent.
 *
 * @param {Array<Array<{ lat, lon }>>} _ways
 * @param {number} [interval=5] — sample every Nth point
 * @returns {Array<{ lat: number, lon: number }>}
 */
export function sampleTrailPoints(_ways, interval = 5) {
  if (!_ways || _ways.length === 0) return [];
  const points = [];
  for (const way of _ways) {
    for (let i = 0; i < way.length; i += interval) {
      points.push(way[i]);
    }
    // Always include the last point of each way
    if (way.length > 0) points.push(way[way.length - 1]);
  }
  return points;
}

/**
 * Classify a trail entry by which park contains the majority of its geometry.
 *
 * @param {{ _ways: Array }} entry — trail with _ways geometry
 * @param {Array<{ name: string, polygon: Array<{ lat, lon }> }>} parks
 * @returns {string | null} — park name, or null if not in any park
 */
export function classifyByPark(entry, parks) {
  const points = sampleTrailPoints(entry._ways);
  if (points.length === 0) return null;

  // Count how many sampled points fall in each park
  const counts = new Map();
  for (const point of points) {
    for (const park of parks) {
      if (pointInPolygon(point, park.polygon)) {
        counts.set(park.name, (counts.get(park.name) || 0) + 1);
      }
    }
  }

  if (counts.size === 0) return null;

  // Majority wins
  let bestPark = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestPark = name;
    }
  }

  return bestPark;
}
