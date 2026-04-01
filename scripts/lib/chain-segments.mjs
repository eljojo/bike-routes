import { haversineM } from './geo.mjs';

/**
 * Chain nearby segments using union-find on center points.
 *
 * @param {Array<{ id: number, center: { lat: number, lon: number }, tags: object }>} segments
 * @param {number} thresholdM — max distance (metres) between centers to chain
 * @returns {Array<{ segmentIds: number[], midpoint: { lat, lon }, bbox: { south, north, west, east }, tags: object[] }>}
 */
export function chainSegments(segments, thresholdM = 50) {
  const n = segments.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) { parent[find(a)] = find(b); }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dist = haversineM(
        [segments[i].center.lon, segments[i].center.lat],
        [segments[j].center.lon, segments[j].center.lat],
      );
      if (dist <= thresholdM) union(i, j);
    }
  }

  // Group by root
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(segments[i]);
  }

  return [...groups.values()].map(segs => {
    const lats = segs.map(s => s.center.lat);
    const lngs = segs.map(s => s.center.lon);
    return {
      segmentIds: segs.map(s => s.id),
      midpoint: {
        lat: lats.reduce((a, b) => a + b, 0) / lats.length,
        lon: lngs.reduce((a, b) => a + b, 0) / lngs.length,
      },
      bbox: {
        south: Math.min(...lats),
        north: Math.max(...lats),
        west: Math.min(...lngs),
        east: Math.max(...lngs),
      },
      tags: segs.map(s => s.tags),
    };
  });
}
