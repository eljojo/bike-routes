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
