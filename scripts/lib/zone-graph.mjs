/**
 * Zone graph — connects zones via bike infrastructure paths.
 *
 * For each pair of zones within 15km, runs A* on the segment graph
 * to find the best bike-infra path between them.
 */

import { haversineM } from './geo.mjs';

const MAX_ZONE_CROW_M = 15000;
const MAX_ASTAR_DIST_M = 20000;
const ZONE_GRID = 0.002;

function gridKey(lng, lat) {
  return `${Math.floor(lng / ZONE_GRID)},${Math.floor(lat / ZONE_GRID)}`;
}

// ---------------------------------------------------------------------------
// Nearest segment lookup
// ---------------------------------------------------------------------------

/**
 * Find the segment index whose centroid is closest to a zone's centerCoord.
 * @param {{ centerCoord: [number, number] }} zone
 * @param {Array<{ centroid: [number, number] }>} segments
 * @returns {number} segment index
 */
export function nearestSegmentToZone(zone, segments) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < segments.length; i++) {
    const d = haversineM(zone.centerCoord, segments[i].centroid);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ---------------------------------------------------------------------------
// A* pathfinding on the segment graph
// ---------------------------------------------------------------------------

/**
 * A* search from one segment to another on the segment graph.
 *
 * @param {number} fromIdx - start segment index
 * @param {number} toIdx - target segment index
 * @param {Array<{ centroid: [number, number], lengthM: number }>} segments
 * @param {Array<Array<{ to: number, cost: number }>>} edges
 * @returns {{ path: number[], distM: number } | null}
 */
export function aStarSegments(fromIdx, toIdx, segments, edges) {
  if (fromIdx === toIdx) return { path: [fromIdx], distM: 0 };

  const targetCentroid = segments[toIdx].centroid;

  // Open set as simple array (graph is small, ~921 nodes)
  // Each entry: { segIdx, gCost, fCost, parent }
  const open = [{ segIdx: fromIdx, gCost: 0, fCost: haversineM(segments[fromIdx].centroid, targetCentroid), parent: -1 }];
  const closed = new Map(); // segIdx -> { gCost, parent }

  while (open.length > 0) {
    // Extract node with lowest fCost
    let bestI = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].fCost < open[bestI].fCost) bestI = i;
    }
    const current = open[bestI];
    open.splice(bestI, 1);

    // Already visited with a better cost?
    if (closed.has(current.segIdx)) continue;
    closed.set(current.segIdx, { gCost: current.gCost, parent: current.parent });

    // Reached target
    if (current.segIdx === toIdx) {
      // Reconstruct path
      const path = [];
      let idx = toIdx;
      while (idx !== -1) {
        path.push(idx);
        idx = closed.get(idx).parent;
      }
      path.reverse();
      return { path, distM: current.gCost };
    }

    // Exceeded max distance
    if (current.gCost > MAX_ASTAR_DIST_M) continue;

    // Expand neighbors
    for (const edge of edges[current.segIdx]) {
      if (closed.has(edge.to)) continue;
      const gCost = current.gCost + edge.cost + segments[edge.to].lengthM;
      const hCost = haversineM(segments[edge.to].centroid, targetCentroid);
      open.push({ segIdx: edge.to, gCost, fCost: gCost + hCost, parent: current.segIdx });
    }
  }

  return null; // No path found
}

// ---------------------------------------------------------------------------
// Infrastructure fraction
// ---------------------------------------------------------------------------

/**
 * Compute the fraction of path segments that are connected via same-axis edges (cost=0).
 * This measures how much of the path follows dedicated bike infrastructure.
 */
function computeInfraFraction(path, edges) {
  if (path.length <= 1) return 1;

  let infraCount = 0;
  let totalCount = 0;

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    const edge = edges[from].find((e) => e.to === to);
    totalCount++;
    if (edge && edge.cost === 0) infraCount++;
  }

  return totalCount > 0 ? infraCount / totalCount : 0;
}

// ---------------------------------------------------------------------------
// Zones along a path
// ---------------------------------------------------------------------------

/**
 * Find which intermediate zones a path passes through.
 *
 * For each segment in the path, checks if its centroid falls in any zone's
 * grid cells. Excludes the start and end zones.
 *
 * @param {number[]} path - segment indices
 * @param {Array} segments
 * @param {Array} zones
 * @param {number} fromZoneIdx
 * @param {number} toZoneIdx
 * @param {Map<string, number[]>} cellToZones - spatial index: cell key -> zone indices
 * @returns {number[]} indices of intermediate zones the path passes through
 */
function findZonesAlong(path, segments, zones, fromZoneIdx, toZoneIdx, cellToZones) {
  const found = new Set();

  for (const segIdx of path) {
    const seg = segments[segIdx];
    const key = gridKey(seg.centroid[0], seg.centroid[1]);
    const zoneIndices = cellToZones.get(key);
    if (!zoneIndices) continue;
    for (const zi of zoneIndices) {
      if (zi !== fromZoneIdx && zi !== toZoneIdx) {
        found.add(zi);
      }
    }
  }

  return [...found];
}

// ---------------------------------------------------------------------------
// Build zone graph (main export)
// ---------------------------------------------------------------------------

/**
 * Build a graph connecting zones via bike infrastructure paths.
 *
 * @param {Array<{ name: string, centerCoord: [number, number], cells: Set<string> }>} zones
 * @param {{ segments: Array, edges: Array<Array<{ to: number, cost: number }>>, segToAxis: Map, axisSegRanges: Map }} graph
 * @returns {Map<string, { fromZone: number, toZone: number, distM: number, infraFraction: number, segPath: number[], zonesAlong: number[] }>}
 */
export function buildZoneGraph(zones, graph) {
  const t0 = Date.now();
  const { segments, edges } = graph;

  // Precompute nearest segment for each zone
  const zoneSegIdx = zones.map((z) => nearestSegmentToZone(z, segments));

  // Build spatial index: cell key -> zone indices (for zonesAlong detection)
  const cellToZones = new Map();
  for (let zi = 0; zi < zones.length; zi++) {
    for (const cell of zones[zi].cells) {
      if (!cellToZones.has(cell)) cellToZones.set(cell, []);
      cellToZones.get(cell).push(zi);
    }
  }

  const zoneEdges = new Map();
  let pairsChecked = 0;
  let connected = 0;

  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const crowDist = haversineM(zones[i].centerCoord, zones[j].centerCoord);
      if (crowDist > MAX_ZONE_CROW_M) continue;
      pairsChecked++;

      const result = aStarSegments(zoneSegIdx[i], zoneSegIdx[j], segments, edges);
      if (!result) continue;

      const { path, distM } = result;
      const infraFraction = computeInfraFraction(path, edges);
      const zonesAlong = findZonesAlong(path, segments, zones, i, j, cellToZones);

      const edge = { fromZone: i, toZone: j, distM, infraFraction, segPath: path, zonesAlong };

      // Store both directions
      zoneEdges.set(`${i}-${j}`, edge);
      zoneEdges.set(`${j}-${i}`, { ...edge, fromZone: j, toZone: i, segPath: [...path].reverse() });
      connected++;
    }
  }

  const elapsed = Date.now() - t0;
  console.log(`[zone-graph] ${pairsChecked} pairs checked, ${connected} connected, ${zones.length} zones (${elapsed}ms)`);

  return zoneEdges;
}
