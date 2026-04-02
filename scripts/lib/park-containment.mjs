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
 */
export function sampleTrailPoints(_ways, interval = 5) {
  if (!_ways || _ways.length === 0) return [];
  const points = [];
  for (const way of _ways) {
    for (let i = 0; i < way.length; i += interval) {
      points.push(way[i]);
    }
    if (way.length > 0) points.push(way[way.length - 1]);
  }
  return points;
}

/**
 * Classify a trail entry by which park contains the majority of its geometry.
 */
export function classifyByPark(entry, parks) {
  const points = sampleTrailPoints(entry._ways);
  if (points.length === 0) return null;

  const counts = new Map();
  for (const point of points) {
    for (const park of parks) {
      if (pointInPolygon(point, park.polygon)) {
        counts.set(park.name, (counts.get(park.name) || 0) + 1);
      }
    }
  }

  if (counts.size === 0) return null;

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

/**
 * Fetch all park/nature_reserve/protected_area polygons in the bbox.
 * Returns array of { name, polygon } for local point-in-polygon checks.
 */
export async function fetchParkPolygons(bbox, queryOverpass) {
  const q = `[out:json][timeout:120];
(
  way["leisure"~"nature_reserve|park"]["name"](${bbox});
  relation["leisure"~"nature_reserve|park"]["name"](${bbox});
  relation["boundary"="protected_area"]["name"](${bbox});
  relation["landuse"="forest"]["name"](${bbox});
);
out geom;`;

  const data = await queryOverpass(q);
  const parks = [];

  for (const el of data.elements) {
    const name = el.tags?.name;
    if (!name) continue;

    let polygon = null;
    if (el.type === 'way' && el.geometry?.length >= 3) {
      polygon = el.geometry;
    } else if (el.type === 'relation' && el.members) {
      // Relations: extract outer ring from members
      const outerWays = el.members
        .filter(m => m.type === 'way' && (m.role === 'outer' || m.role === ''))
        .flatMap(m => m.geometry || []);
      if (outerWays.length >= 3) polygon = outerWays;
    }

    if (polygon) {
      parks.push({ name, polygon });
    }
  }

  console.log(`  Fetched ${parks.length} park polygons for containment checks`);
  return parks;
}

/**
 * Split a connectivity cluster into sub-clusters by park membership.
 * Members not in any park stay together in a null-park sub-cluster.
 *
 * @param {{ members: Array, centroid: object }} cluster
 * @param {Array<{ name, polygon }>} parks
 * @returns {Map<string|null, Array>} — park name → members
 */
export function splitClusterByPark(cluster, parks) {
  const byPark = new Map();
  for (const member of cluster.members) {
    const park = classifyByPark(member, parks);
    if (!byPark.has(park)) byPark.set(park, []);
    byPark.get(park).push(member);
  }
  return byPark;
}
