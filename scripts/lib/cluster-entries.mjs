// cluster-entries.mjs
import { haversineM, corridorWidth } from './geo.mjs';

const MAX_CORRIDOR_WIDTH_M = 2000;

const UNPAVED = new Set(['ground', 'gravel', 'dirt', 'earth', 'grass', 'sand', 'mud', 'compacted', 'fine_gravel', 'woodchips', 'unpaved', 'dirt/sand']);

/**
 * Classify an entry as 'trail', 'paved', or 'road'.
 * Entries of different types don't merge — trails stay with trails,
 * paved paths with paved paths, road lanes with road lanes.
 */
function pathType(entry) {
  if (entry.parallel_to) return 'road';
  const hw = entry.highway;
  const surface = entry.surface;
  if (hw === 'path' || hw === 'footway') {
    return (surface && !UNPAVED.has(surface)) ? 'paved' : 'trail';
  }
  if (hw === 'cycleway') {
    return (surface && UNPAVED.has(surface)) ? 'trail' : 'paved';
  }
  // Roads with bike lanes (tertiary, secondary, etc.)
  if (hw && hw !== 'path' && hw !== 'cycleway' && hw !== 'footway') return 'road';
  return null; // unknown — compatible with anything
}

/**
 * Cluster bikepaths.yml entries by anchor proximity with operator + type + corridor-width guards.
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

  // Track all anchors per component for corridor width check
  const compAnchors = withAnchors.map(({ entry }) => [...entry.anchors]);

  function operatorsCompatible(a, b) {
    if (!a || !b) return true;
    return a === b;
  }

  function typesCompatible(a, b) {
    if (!a || !b) return true; // unknown type merges with anything
    return a === b;
  }

  // Pre-compute path types
  const entryTypes = withAnchors.map(({ entry }) => pathType(entry));

  function tryUnion(i, j) {
    const ri = find(i), rj = find(j);
    if (ri === rj) return;

    if (!operatorsCompatible(withAnchors[ri].entry.operator, withAnchors[rj].entry.operator)) return;
    if (!typesCompatible(entryTypes[i], entryTypes[j])) return;

    // Corridor width guard: check the minor-axis extent of the merged anchor cloud
    const mergedAnchors = [...compAnchors[ri], ...compAnchors[rj]];
    if (corridorWidth(mergedAnchors) > MAX_CORRIDOR_WIDTH_M) return;

    parent[ri] = rj;
    compAnchors[rj] = mergedAnchors;
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
