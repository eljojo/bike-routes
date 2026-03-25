/**
 * Road network graph for gap routing.
 * Builds from Overpass road ways. Uses Dijkstra for shortest cycling path.
 */

import { haversineM } from './geo.mjs';

const GRID = 0.0001; // ~10m precision for node dedup

function nodeKey(lat, lon) {
  return `${Math.round(lat / GRID)},${Math.round(lon / GRID)}`;
}

const ROAD_WEIGHTS = {
  cycleway: 1.0, path: 1.1, living_street: 1.2,
  footway: 1.3, pedestrian: 1.3, residential: 1.5,
  service: 1.5, tertiary: 1.8, secondary: 2.5,
};

/**
 * Build a road graph from Overpass way elements.
 * @param {Array} ways - Overpass way elements with .geometry and .tags
 * @returns {{ nodes: Map, adj: Map, getNodeId: Function }}
 */
export function buildRoadGraph(ways) {
  const nodes = new Map(); // key → { lat, lon, id }
  const adj = new Map();   // nodeId → [{ to, distM, weight }]
  let nextId = 0;

  function getNodeId(lat, lon) {
    const key = nodeKey(lat, lon);
    if (!nodes.has(key)) {
      nodes.set(key, { lat, lon, id: nextId++ });
    }
    return nodes.get(key).id;
  }

  function addEdge(fromId, toId, distM, weight) {
    if (!adj.has(fromId)) adj.set(fromId, []);
    if (!adj.has(toId)) adj.set(toId, []);
    adj.get(fromId).push({ to: toId, distM, weight });
    adj.get(toId).push({ to: fromId, distM, weight });
  }

  for (const way of ways) {
    const highway = way.tags?.highway || 'residential';
    const w = ROAD_WEIGHTS[highway] || 2.0;
    const geom = way.geometry;

    for (let i = 0; i < geom.length - 1; i++) {
      const aId = getNodeId(geom[i].lat, geom[i].lon);
      const bId = getNodeId(geom[i + 1].lat, geom[i + 1].lon);
      if (aId === bId) continue;
      const dist = haversineM(
        [geom[i].lon, geom[i].lat],
        [geom[i + 1].lon, geom[i + 1].lat]
      );
      addEdge(aId, bId, dist, dist * w);
    }
  }

  console.log(`[roads] Graph: ${nextId} nodes, ${[...adj.values()].reduce((s, e) => s + e.length, 0)} edges`);
  return { nodes, adj, getNodeId };
}

/**
 * Find the nearest graph node to a [lng, lat] coordinate.
 * Checks the 9 grid cells around the coordinate.
 * @returns {number|null} node ID or null
 */
export function findNearestNode(graph, coord) {
  const [lng, lat] = coord;
  let bestId = null;
  let bestDist = Infinity;

  // Check nearby grid cells
  for (let dlat = -1; dlat <= 1; dlat++) {
    for (let dlng = -1; dlng <= 1; dlng++) {
      const key = nodeKey(lat + dlat * GRID, lng + dlng * GRID);
      const node = graph.nodes.get(key);
      if (node) {
        const d = haversineM(coord, [node.lon, node.lat]);
        if (d < bestDist) {
          bestDist = d;
          bestId = node.id;
        }
      }
    }
  }

  // If nothing in adjacent cells, scan wider (within 200m)
  if (bestId === null) {
    for (const node of graph.nodes.values()) {
      const d = haversineM(coord, [node.lon, node.lat]);
      if (d < 200 && d < bestDist) {
        bestDist = d;
        bestId = node.id;
      }
    }
  }

  return bestId;
}

/**
 * Dijkstra shortest path between two [lng, lat] coordinates.
 * Uses weighted distance (prefers cycleways over roads).
 * @param {object} graph - from buildRoadGraph
 * @param {[number,number]} from - [lng, lat]
 * @param {[number,number]} to - [lng, lat]
 * @param {number} maxDistM - maximum search distance (default 5000)
 * @returns {{ distM: number, path: Array<[number,number]> } | null}
 */
export function shortestPath(graph, from, to, maxDistM = 5000) {
  const fromId = findNearestNode(graph, from);
  const toId = findNearestNode(graph, to);
  if (fromId === null || toId === null) return null;
  if (fromId === toId) return { distM: 0, path: [from, to] };

  // Dijkstra with simple array-based priority queue
  const dist = new Map();
  const prev = new Map();
  const visited = new Set();

  dist.set(fromId, 0);

  const pq = [{ id: fromId, cost: 0 }];

  while (pq.length > 0) {
    // Extract min
    let minIdx = 0;
    for (let i = 1; i < pq.length; i++) {
      if (pq[i].cost < pq[minIdx].cost) minIdx = i;
    }
    const { id: u, cost } = pq.splice(minIdx, 1)[0];

    if (visited.has(u)) continue;
    visited.add(u);

    if (u === toId) break;

    // Weighted distance cutoff
    if (cost > maxDistM * 3) break;

    const neighbors = graph.adj.get(u) || [];
    for (const { to: v, weight } of neighbors) {
      if (visited.has(v)) continue;
      const newDist = cost + weight;
      if (!dist.has(v) || newDist < dist.get(v)) {
        dist.set(v, newDist);
        prev.set(v, u);
        pq.push({ id: v, cost: newDist });
      }
    }
  }

  if (!prev.has(toId)) return null;

  // Reconstruct path
  const nodeById = new Map();
  for (const node of graph.nodes.values()) {
    nodeById.set(node.id, node);
  }

  const path = [];
  let current = toId;
  while (current !== undefined) {
    const node = nodeById.get(current);
    if (node) path.unshift([node.lon, node.lat]);
    current = prev.get(current);
  }

  // Calculate actual distance (unweighted)
  let totalDist = 0;
  for (let i = 1; i < path.length; i++) {
    totalDist += haversineM(path[i - 1], path[i]);
  }

  return { distM: Math.round(totalDist), path };
}
