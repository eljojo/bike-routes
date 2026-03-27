/**
 * Pure geographic utility functions.
 * All coordinates are [lng, lat] (GeoJSON order).
 */

const R = 6_371_000; // Earth radius in metres
const toRad = (d) => (d * Math.PI) / 180;

/** Haversine distance in metres between two [lng, lat] points. */
export function haversineM([lng1, lat1], [lng2, lat2]) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Flatten all coordinates of a LineString or MultiLineString to [lng, lat] pairs. */
export function allCoords(geometry) {
  if (geometry.type === 'LineString') {
    return geometry.coordinates.map((c) => c.slice(0, 2));
  }
  // MultiLineString
  return geometry.coordinates.flatMap((line) => line.map((c) => c.slice(0, 2)));
}

/**
 * First and last coordinate of a LineString or MultiLineString.
 * Returns { start: [lng, lat], end: [lng, lat] }.
 */
export function endpoints(geometry) {
  if (geometry.type === 'LineString') {
    const coords = geometry.coordinates;
    return {
      start: coords[0].slice(0, 2),
      end: coords[coords.length - 1].slice(0, 2),
    };
  }
  // MultiLineString
  const coords = geometry.coordinates;
  const firstLine = coords[0];
  const lastLine = coords[coords.length - 1];
  return {
    start: firstLine[0].slice(0, 2),
    end: lastLine[lastLine.length - 1].slice(0, 2),
  };
}

/** Total length in metres of a LineString or MultiLineString. */
export function lineLength(geometry) {
  let total = 0;
  const lines =
    geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.coordinates;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      total += haversineM(line[i - 1].slice(0, 2), line[i].slice(0, 2));
    }
  }
  return total;
}

/** Average of all coordinates — centre point of a LineString or MultiLineString. */
export function centroid(geometry) {
  const coords = allCoords(geometry);
  let sumLng = 0, sumLat = 0;
  for (const [lng, lat] of coords) {
    sumLng += lng;
    sumLat += lat;
  }
  return [sumLng / coords.length, sumLat / coords.length];
}

/**
 * Bearing in degrees from first to last point (0 = north, 90 = east).
 * Works on LineString or MultiLineString.
 */
export function bearing(geometry) {
  const { start, end } = endpoints(geometry);
  const [lng1, lat1] = start.map(toRad);
  const [lng2, lat2] = end.map(toRad);
  const dLng = lng2 - lng1;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/**
 * Cardinal orientation based on bearing.
 * Returns 'ns' (north–south, bearing near 0/180) or 'ew' (east–west, near 90/270).
 */
export function orientation(geometry) {
  const b = bearing(geometry);
  // Normalize to 0–90 quadrant
  const q = b % 180;
  return q < 45 || q > 135 ? 'ns' : 'ew';
}

/**
 * Minimum distance between any endpoint pair of two segments.
 * a and b must have .start and .end properties (each [lng, lat]).
 * Returns { distance, fromEnd, toEnd } where fromEnd/toEnd are 'start'|'end'.
 */
export function minEndpointDistance(a, b) {
  let best = { distance: Infinity, fromEnd: null, toEnd: null };
  for (const [aLabel, aCoord] of [['start', a.start], ['end', a.end]]) {
    for (const [bLabel, bCoord] of [['start', b.start], ['end', b.end]]) {
      const d = haversineM(aCoord, bCoord);
      if (d < best.distance) {
        best = { distance: d, fromEnd: aLabel, toEnd: bLabel };
      }
    }
  }
  return best;
}

/** Human-readable distance: "1.5 km" or "300 m". */
export function formatDistance(metres) {
  return metres >= 1000
    ? `${(metres / 1000).toFixed(1)} km`
    : `${Math.round(metres)} m`;
}

const AREA_GRID = 0.002; // ~200m cells, matches zone grid

/**
 * Convert a polygon to a set of grid cell keys.
 * Fills the interior using ray-casting point-in-polygon.
 * @param {Array<[number,number]>} coords - polygon vertices [lng, lat]
 * @param {number} [gridSize=0.002] - grid cell size in degrees
 * @returns {Set<string>} grid cell keys
 */
export function polygonToGridCells(coords, gridSize = AREA_GRID) {
  if (coords.length < 3) return new Set();

  const lats = coords.map((c) => c[1]);
  const lngs = coords.map((c) => c[0]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

  const cells = new Set();
  const minGy = Math.floor(minLat / gridSize);
  const maxGy = Math.floor(maxLat / gridSize);
  const minGx = Math.floor(minLng / gridSize);
  const maxGx = Math.floor(maxLng / gridSize);

  for (let gy = minGy; gy <= maxGy; gy++) {
    for (let gx = minGx; gx <= maxGx; gx++) {
      const testLng = (gx + 0.5) * gridSize;
      const testLat = (gy + 0.5) * gridSize;
      if (pointInPolygon(testLng, testLat, coords)) {
        cells.add(`${gx},${gy}`);
      }
    }
  }

  // Also add boundary cells
  for (const [lng, lat] of coords) {
    cells.add(`${Math.floor(lng / gridSize)},${Math.floor(lat / gridSize)}`);
  }

  return cells;
}

/**
 * Ray-casting point-in-polygon test.
 */
function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Check if a [lng, lat] coordinate is inside a set of grid cells.
 * @returns {boolean}
 */
export function isPointInCells(coord, cells, gridSize = AREA_GRID) {
  const key = `${Math.floor(coord[0] / gridSize)},${Math.floor(coord[1] / gridSize)}`;
  return cells.has(key);
}

/**
 * Project a point onto a polyline and return the scalar distance along it.
 *
 * For each line segment, compute the perpendicular projection. If the
 * projection falls within the segment, use it. Otherwise, use the nearer
 * endpoint. Returns the closest point with its scalar position.
 *
 * @param {[number, number]} point - [lng, lat]
 * @param {Array<[number, number]>} polyline - array of [lng, lat] coords
 * @returns {{ coord: [number, number], scalar: number, totalLength: number, dist: number }}
 */
/**
 * 2D line-segment intersection.
 * Segments are (a1→a2) and (b1→b2), each [lng, lat].
 * Returns { t, u, coord } if they cross, or null.
 * t ∈ [0,1] is the parameter on segment A, u on segment B.
 * Uses planar approximation (fine for <10km segments in Santiago).
 */
export function segmentIntersection(a1, a2, b1, b2) {
  const dx1 = a2[0] - a1[0], dy1 = a2[1] - a1[1];
  const dx2 = b2[0] - b1[0], dy2 = b2[1] - b1[1];
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-12) return null; // parallel or collinear
  const dx3 = b1[0] - a1[0], dy3 = b1[1] - a1[1];
  const t = (dx3 * dy2 - dy3 * dx2) / denom;
  const u = (dx3 * dy1 - dy3 * dx1) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null; // outside segments
  return {
    t, u,
    coord: [a1[0] + t * dx1, a1[1] + t * dy1],
  };
}

/**
 * Find junction candidates between two measured polylines.
 *
 * Classifies candidates as:
 * - cross: actual segment-segment intersection
 * - touch: endpoint within tolerance of other polyline
 * - gap: nearest-pair fallback (no physical connection)
 *
 * Each candidate: { type, coord, scalarA, scalarB, dist, bearingA, bearingB }
 *
 * @param {{ coords, cumDist, totalLength }} polyA
 * @param {{ coords, cumDist, totalLength }} polyB
 * @returns {Array} candidates sorted by preference (cross > touch > gap)
 */
export function findJunctionCandidates(polyA, polyB) {
  const candidates = [];

  // --- Cross candidates: actual segment-segment intersections ---
  let cumDistA = 0;
  for (let i = 0; i < polyA.coords.length - 1; i++) {
    const a1 = polyA.coords[i], a2 = polyA.coords[i + 1];
    const segLenA = haversineM(a1, a2);
    // Bbox filter for A segment
    const aMinLng = Math.min(a1[0], a2[0]) - 0.001;
    const aMaxLng = Math.max(a1[0], a2[0]) + 0.001;
    const aMinLat = Math.min(a1[1], a2[1]) - 0.001;
    const aMaxLat = Math.max(a1[1], a2[1]) + 0.001;

    let cumDistB = 0;
    for (let j = 0; j < polyB.coords.length - 1; j++) {
      const b1 = polyB.coords[j], b2 = polyB.coords[j + 1];
      const segLenB = haversineM(b1, b2);

      // Quick bbox reject
      if (Math.min(b1[0], b2[0]) > aMaxLng || Math.max(b1[0], b2[0]) < aMinLng ||
          Math.min(b1[1], b2[1]) > aMaxLat || Math.max(b1[1], b2[1]) < aMinLat) {
        cumDistB += segLenB;
        continue;
      }

      const ix = segmentIntersection(a1, a2, b1, b2);
      if (ix) {
        const scalarA = cumDistA + ix.t * segLenA;
        const scalarB = cumDistB + ix.u * segLenB;
        // Bearing at intersection: direction of each segment
        const bearingA = Math.atan2(a2[0] - a1[0], a2[1] - a1[1]);
        const bearingB = Math.atan2(b2[0] - b1[0], b2[1] - b1[1]);
        candidates.push({
          type: 'cross', coord: ix.coord,
          scalarA, scalarB, dist: 0,
          bearingA, bearingB,
        });
      }
      cumDistB += segLenB;
    }
    cumDistA += segLenA;
  }

  // --- Touch candidates: endpoints within 40m of other polyline ---
  // A's endpoints near B
  for (const [idx, scalar] of [[0, 0], [polyA.coords.length - 1, polyA.totalLength]]) {
    const proj = nearestPointOnPolyline(polyA.coords[idx], polyB.coords);
    if (proj.dist < 40) {
      candidates.push({
        type: 'touch', coord: polyA.coords[idx],
        scalarA: scalar, scalarB: proj.scalar, dist: proj.dist,
        bearingA: null, bearingB: null,
      });
    }
  }
  // B's endpoints near A
  for (const [idx, scalar] of [[0, 0], [polyB.coords.length - 1, polyB.totalLength]]) {
    const proj = nearestPointOnPolyline(polyB.coords[idx], polyA.coords);
    if (proj.dist < 40) {
      candidates.push({
        type: 'touch', coord: polyB.coords[idx],
        scalarA: proj.scalar, scalarB: scalar, dist: proj.dist,
        bearingA: null, bearingB: null,
      });
    }
  }

  // --- Gap candidate: overall nearest pair (fallback) ---
  {
    let bestDist = Infinity, bestA = 0, bestB = 0, bestCoord = polyA.coords[0];
    const stepA = Math.max(1, Math.floor(polyA.coords.length / 80));
    for (let i = 0; i < polyA.coords.length; i += stepA) {
      const proj = nearestPointOnPolyline(polyA.coords[i], polyB.coords);
      if (proj.dist < bestDist) {
        bestDist = proj.dist;
        bestA = polyA.cumDist[i];
        bestB = proj.scalar;
        bestCoord = proj.coord;
      }
    }
    const stepB = Math.max(1, Math.floor(polyB.coords.length / 80));
    for (let i = 0; i < polyB.coords.length; i += stepB) {
      const proj = nearestPointOnPolyline(polyB.coords[i], polyA.coords);
      if (proj.dist < bestDist) {
        bestDist = proj.dist;
        bestA = proj.scalar;
        bestB = polyB.cumDist[i];
        bestCoord = proj.coord;
      }
    }
    candidates.push({
      type: 'gap', coord: bestCoord,
      scalarA: bestA, scalarB: bestB, dist: bestDist,
      bearingA: null, bearingB: null,
    });
  }

  // Sort: cross > touch > gap, then by distance
  const typePriority = { cross: 0, touch: 1, gap: 2 };
  candidates.sort((a, b) => {
    const tp = typePriority[a.type] - typePriority[b.type];
    if (tp !== 0) return tp;
    return a.dist - b.dist;
  });

  return candidates;
}

export function nearestPointOnPolyline(point, polyline) {
  let bestDist = Infinity;
  let bestScalar = 0;
  let bestCoord = polyline[0];
  let cumDist = 0;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const segLen = haversineM(a, b);

    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;

    let t = 0;
    if (lenSq > 0) {
      t = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
    }

    const proj = [a[0] + t * dx, a[1] + t * dy];
    const d = haversineM(point, proj);

    if (d < bestDist) {
      bestDist = d;
      bestScalar = cumDist + t * segLen;
      bestCoord = proj;
    }

    cumDist += segLen;
  }

  return { coord: bestCoord, scalar: bestScalar, totalLength: cumDist, dist: bestDist };
}
