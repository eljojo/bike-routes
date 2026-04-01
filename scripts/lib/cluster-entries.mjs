// cluster-entries.mjs
import { haversineM } from './geo.mjs';

const MAX_DIAMETER_M = 5000;

/**
 * Cluster bikepaths.yml entries by anchor proximity with operator + diameter guards.
 *
 * @param {Array<{ name: string, anchors?: Array<[number, number]>, operator?: string, grouped_from?: string[], [k: string]: any }>} entries
 * @param {number} thresholdM — max distance between anchor points to cluster (default 200m)
 * @returns {Array<{ members: typeof entries, bbox, centroid, existingGroup?, newMembers? }>}
 *          Only clusters with 2+ members returned. existingGroup set if cluster contains a grouped_from entry.
 */
export function clusterEntries(entries, thresholdM = 200) {
  const withAnchors = entries
    .map((e, i) => ({ entry: e, index: i }))
    .filter(({ entry }) => entry.anchors && entry.anchors.length > 0);

  const n = withAnchors.length;
  if (n < 2) return [];

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }

  // Track bbox per component for diameter check
  const compBbox = withAnchors.map(({ entry }) => {
    const lngs = entry.anchors.map(a => a[0]);
    const lats = entry.anchors.map(a => a[1]);
    return {
      south: Math.min(...lats), north: Math.max(...lats),
      west: Math.min(...lngs), east: Math.max(...lngs),
    };
  });

  function mergeBbox(a, b) {
    return {
      south: Math.min(a.south, b.south), north: Math.max(a.north, b.north),
      west: Math.min(a.west, b.west), east: Math.max(a.east, b.east),
    };
  }

  function bboxDiagonalM(bb) {
    return haversineM([bb.west, bb.south], [bb.east, bb.north]);
  }

  function operatorsCompatible(a, b) {
    if (!a || !b) return true;
    return a === b;
  }

  function tryUnion(i, j) {
    const ri = find(i), rj = find(j);
    if (ri === rj) return;

    if (!operatorsCompatible(withAnchors[ri].entry.operator, withAnchors[rj].entry.operator)) return;

    const merged = mergeBbox(compBbox[ri], compBbox[rj]);
    if (bboxDiagonalM(merged) > MAX_DIAMETER_M) return;

    parent[ri] = rj;
    compBbox[rj] = merged;
  }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const anchorsI = withAnchors[i].entry.anchors;
      const anchorsJ = withAnchors[j].entry.anchors;
      let nearest = Infinity;
      for (const ai of anchorsI) {
        for (const aj of anchorsJ) {
          const d = haversineM(ai, aj);
          if (d < nearest) nearest = d;
        }
      }
      if (nearest <= thresholdM) tryUnion(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(withAnchors[i].entry);
  }

  return [...groups.values()]
    .filter(members => members.length >= 2)
    .map(members => {
      const allAnchors = members.flatMap(m => m.anchors || []);
      const lngs = allAnchors.map(a => a[0]);
      const lats = allAnchors.map(a => a[1]);

      const existingGroup = members.find(m => m.grouped_from);
      const newMembers = existingGroup
        ? members.filter(m => m !== existingGroup)
        : members;

      return {
        members,
        bbox: {
          south: Math.min(...lats), north: Math.max(...lats),
          west: Math.min(...lngs), east: Math.max(...lngs),
        },
        centroid: {
          lat: lats.reduce((a, b) => a + b, 0) / lats.length,
          lon: lngs.reduce((a, b) => a + b, 0) / lngs.length,
        },
        existingGroup: existingGroup || null,
        newMembers,
      };
    });
}
