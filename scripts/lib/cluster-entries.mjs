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

function operatorsCompatible(a, b) {
  if (!a || !b) return true;
  return a === b;
}

function typesCompatible(a, b) {
  if (!a || !b) return true; // unknown type merges with anything
  return a === b;
}

const TOUCHING_M = 10;

export function clusterByConnectivity(entries) {
  const withWays = entries
    .map((e, i) => ({ entry: e, index: i }))
    .filter(({ entry }) => entry._ways && entry._ways.length > 0);

  const n = withWays.length;
  if (n < 2) return [];

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }

  const entryTypes = withWays.map(({ entry }) => pathType(entry));
  const entryEndpoints = withWays.map(({ entry }) => {
    const eps = [];
    for (const way of entry._ways) {
      if (way.length >= 1) {
        eps.push(way[0]);
        if (way.length >= 2) eps.push(way[way.length - 1]);
      }
    }
    return eps;
  });

  const compEndpoints = entryEndpoints.map(eps =>
    eps.map(p => [p.lon, p.lat])
  );

  function tryUnion(i, j) {
    const ri = find(i), rj = find(j);
    if (ri === rj) return;
    if (!operatorsCompatible(withWays[ri].entry.operator, withWays[rj].entry.operator)) return;
    if (!typesCompatible(entryTypes[i], entryTypes[j])) return;
    const mergedPts = [...compEndpoints[ri], ...compEndpoints[rj]];
    if (corridorWidth(mergedPts) > MAX_CORRIDOR_WIDTH_M) return;
    parent[ri] = rj;
    compEndpoints[rj] = mergedPts;
  }

  // Phase 1: Exact shared-node detection via coordinate-string inverted index
  const nodeIndex = new Map();
  for (let ei = 0; ei < n; ei++) {
    for (const way of withWays[ei].entry._ways) {
      for (const node of way) {
        const key = `${node.lat},${node.lon}`;
        if (!nodeIndex.has(key)) nodeIndex.set(key, new Set());
        nodeIndex.get(key).add(ei);
      }
    }
  }

  for (const [, entrySet] of nodeIndex) {
    if (entrySet.size < 2) continue;
    const indices = [...entrySet];
    for (let a = 1; a < indices.length; a++) {
      tryUnion(indices[0], indices[a]);
    }
  }

  // Phase 2: Endpoint proximity (within TOUCHING_M)
  const EP_GRID = 0.00015;
  const epGrid = new Map();
  for (let ei = 0; ei < n; ei++) {
    for (const ep of entryEndpoints[ei]) {
      const gx = Math.floor(ep.lon / EP_GRID);
      const gy = Math.floor(ep.lat / EP_GRID);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const key = `${gx + dx},${gy + dy}`;
          if (!epGrid.has(key)) epGrid.set(key, []);
          epGrid.get(key).push({ entryIdx: ei, lon: ep.lon, lat: ep.lat });
        }
      }
    }
  }

  for (const [, eps] of epGrid) {
    for (let a = 0; a < eps.length; a++) {
      for (let b = a + 1; b < eps.length; b++) {
        if (eps[a].entryIdx === eps[b].entryIdx) continue;
        if (find(eps[a].entryIdx) === find(eps[b].entryIdx)) continue;
        const d = haversineM([eps[a].lon, eps[a].lat], [eps[b].lon, eps[b].lat]);
        if (d <= TOUCHING_M) {
          tryUnion(eps[a].entryIdx, eps[b].entryIdx);
        }
      }
    }
  }

  // Build result clusters
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(withWays[i].entry);
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

