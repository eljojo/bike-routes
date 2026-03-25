/**
 * Zone-to-zone route generation.
 *
 * Generates one-way routes and loop routes (triangles, rectangles)
 * by combining zone graph edges.
 */

import { haversineM } from './geo.mjs';
import { buildRoute, segmentsToAxisChain } from './trips.mjs';

const ZONE_GRID = 0.002;

// ---------------------------------------------------------------------------
// Nearest anchor lookup
// ---------------------------------------------------------------------------

/**
 * Find the anchor with the highest anchorScore within 2km of a zone's centerCoord.
 * @param {{ centerCoord: [number, number] }} zone
 * @param {Array<{ lat: number, lng: number, anchorScore: number }>} anchors
 * @returns {object | null}
 */
function nearestAnchorToZone(zone, anchors) {
  let best = null;
  let bestScore = -Infinity;
  for (const anchor of anchors) {
    const d = haversineM(zone.centerCoord, [anchor.lng, anchor.lat]);
    if (d > 2000) continue;
    if (anchor.anchorScore > bestScore) {
      bestScore = anchor.anchorScore;
      best = anchor;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Collinearity check
// ---------------------------------------------------------------------------

/**
 * Check if three zones are approximately collinear (or too close together).
 * Uses cross product for area and haversine for side lengths.
 */
function areCollinear(zA, zB, zC) {
  const [ax, ay] = zA.centerCoord;
  const [bx, by] = zB.centerCoord;
  const [cx, cy] = zC.centerCoord;
  const area = Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay));
  const maxSide = Math.max(
    haversineM(zA.centerCoord, zB.centerCoord),
    haversineM(zB.centerCoord, zC.centerCoord),
    haversineM(zC.centerCoord, zA.centerCoord),
  );
  // Area in degree^2 is tiny, so compare ratio
  return area < 0.001 || maxSide < 1000; // too narrow or too small
}

// ---------------------------------------------------------------------------
// Zone interest scoring
// ---------------------------------------------------------------------------

/**
 * Score the "interest" of a zone-based route.
 *
 * @param {Array} zones - all zones
 * @param {number[]} zoneIndices - indices of zones this route touches (start, end, intermediates)
 * @param {Map} zoneEdges - the zone graph edges
 * @param {Set<string>} repulsionCells - motorway cells
 * @param {Set<string>} treeCells - tree row cells
 * @param {number[]} segPath - segment indices in the route
 * @param {Array} segments - all segments from the graph
 * @returns {number}
 */
function scoreZoneInterest(zones, zoneIndices, zoneEdges, repulsionCells, treeCells, segPath, segments) {
  let score = 0;

  // Start/end zone magnetism
  if (zoneIndices.length >= 2) {
    score += zones[zoneIndices[0]].magnetism ?? 0;
    score += zones[zoneIndices[zoneIndices.length - 1]].magnetism ?? 0;
  }

  // Intermediate zones bonus (x0.5)
  for (let i = 1; i < zoneIndices.length - 1; i++) {
    score += (zones[zoneIndices[i]].magnetism ?? 0) * 0.5;
  }

  // Type diversity bonus: +2 per unique type beyond 1, max 6
  const types = new Set(zoneIndices.map((zi) => zones[zi].type));
  score += Math.min(6, (types.size - 1) * 2);

  // Repulsion penalty: fraction of segPath centroids in repulsionCells * -10
  if (repulsionCells.size > 0 && segPath.length > 0) {
    let repulsionHits = 0;
    for (const segIdx of segPath) {
      const c = segments[segIdx].centroid;
      const key = `${Math.floor(c[0] / ZONE_GRID)},${Math.floor(c[1] / ZONE_GRID)}`;
      if (repulsionCells.has(key)) repulsionHits++;
    }
    score += (repulsionHits / segPath.length) * -10;
  }

  // Tree bonus: fraction in treeCells * +2
  if (treeCells.size > 0 && segPath.length > 0) {
    let treeHits = 0;
    for (const segIdx of segPath) {
      const c = segments[segIdx].centroid;
      const key = `${Math.floor(c[0] / ZONE_GRID)},${Math.floor(c[1] / ZONE_GRID)}`;
      if (treeCells.has(key)) treeHits++;
    }
    score += (treeHits / segPath.length) * 2;
  }

  return score;
}

// ---------------------------------------------------------------------------
// One-way routes
// ---------------------------------------------------------------------------

/**
 * Generate one-way routes between zone pairs.
 */
function generateOneWayRoutes(zones, zoneEdges, graph, axes, anchors) {
  const routes = [];

  for (const [key, edge] of zoneEdges) {
    const [iStr, jStr] = key.split('-');
    const i = Number(iStr);
    const j = Number(jStr);

    // Only process once per pair (i < j)
    if (i >= j) continue;

    // Filter: 3-30km
    if (edge.distM < 3000 || edge.distM > 30000) continue;

    // Convert segPath to axis chain
    const axisChain = segmentsToAxisChain(edge.segPath, graph, axes);
    if (axisChain.length === 0) continue;

    // Find anchors near each zone
    const startAnchor = nearestAnchorToZone(zones[i], anchors);
    const endAnchor = nearestAnchorToZone(zones[j], anchors);
    if (!startAnchor || !endAnchor) continue;

    // Build route
    const route = buildRoute(axisChain, startAnchor, endAnchor, anchors);
    if (!route) continue;

    // Add zone interest metadata
    const zoneIndices = [i, ...edge.zonesAlong, j];
    route.zoneInterest = scoreZoneInterest(zones, zoneIndices, zoneEdges, new Set(), new Set(), edge.segPath, graph.segments);
    route.source = 'zone-oneway';
    routes.push(route);
  }

  console.log(`[zone-routes] ${routes.length} one-way routes`);
  return routes;
}

// ---------------------------------------------------------------------------
// Triangle loops
// ---------------------------------------------------------------------------

/**
 * Generate triangle loop routes through 3 zones.
 * Uses edge existence to limit the O(n^3) search space.
 */
function generateTriangleLoops(zones, zoneEdges, graph, axes, anchors) {
  const routes = [];

  // Build adjacency list from zone edges for fast lookup
  const adj = new Map(); // zoneIdx -> Set<zoneIdx>
  for (const [key] of zoneEdges) {
    const [iStr, jStr] = key.split('-');
    const i = Number(iStr);
    const j = Number(jStr);
    if (!adj.has(i)) adj.set(i, new Set());
    adj.get(i).add(j);
  }

  for (let a = 0; a < zones.length; a++) {
    const aNeighbors = adj.get(a);
    if (!aNeighbors) continue;

    for (const b of aNeighbors) {
      if (b <= a) continue;
      const bNeighbors = adj.get(b);
      if (!bNeighbors) continue;

      for (const c of bNeighbors) {
        if (c <= b) continue;
        // Need edge c -> a (or a -> c)
        if (!zoneEdges.has(`${c}-${a}`) && !zoneEdges.has(`${a}-${c}`)) continue;

        const edgeAB = zoneEdges.get(`${a}-${b}`);
        const edgeBC = zoneEdges.get(`${b}-${c}`);
        const edgeCA = zoneEdges.get(`${c}-${a}`) ?? zoneEdges.get(`${a}-${c}`);
        if (!edgeAB || !edgeBC || !edgeCA) continue;

        // Total distance: 5-35km
        const totalDist = edgeAB.distM + edgeBC.distM + edgeCA.distM;
        if (totalDist < 5000 || totalDist > 35000) continue;

        // Check not collinear
        if (areCollinear(zones[a], zones[b], zones[c])) continue;

        // Concatenate segment paths
        const edgeCAPath = zoneEdges.has(`${c}-${a}`) ? zoneEdges.get(`${c}-${a}`).segPath : [...zoneEdges.get(`${a}-${c}`).segPath].reverse();
        const fullSegPath = [...edgeAB.segPath, ...edgeBC.segPath, ...edgeCAPath];

        // Convert to axis chain
        const axisChain = segmentsToAxisChain(fullSegPath, graph, axes);
        if (axisChain.length === 0) continue;

        // Find anchor near zone a (loop start/end)
        const anchor = nearestAnchorToZone(zones[a], anchors);
        if (!anchor) continue;

        // Build loop route (same start/end anchor)
        const route = buildRoute(axisChain, anchor, anchor, anchors);
        if (!route) continue;

        const zoneIndices = [a, b, c];
        route.zoneInterest = scoreZoneInterest(zones, zoneIndices, zoneEdges, new Set(), new Set(), fullSegPath, graph.segments);
        route.source = 'zone-triangle';
        routes.push(route);
      }
    }
  }

  console.log(`[zone-routes] ${routes.length} triangle loops`);
  return routes;
}

// ---------------------------------------------------------------------------
// Rectangle loops
// ---------------------------------------------------------------------------

/**
 * Check that 4 zones are spread in roughly 4 quadrants around their centroid.
 */
function hasQuadrantSpread(zones, indices) {
  // Compute centroid of the 4 zones
  let sumLng = 0;
  let sumLat = 0;
  for (const idx of indices) {
    sumLng += zones[idx].centerCoord[0];
    sumLat += zones[idx].centerCoord[1];
  }
  const cLng = sumLng / 4;
  const cLat = sumLat / 4;

  // Check that zones span at least 2 different quadrants
  const quadrants = new Set();
  for (const idx of indices) {
    const qx = zones[idx].centerCoord[0] >= cLng ? 1 : 0;
    const qy = zones[idx].centerCoord[1] >= cLat ? 1 : 0;
    quadrants.add(`${qx},${qy}`);
  }
  return quadrants.size >= 3; // at least 3 of 4 quadrants occupied
}

/**
 * Generate rectangle loop routes through 4 zones.
 * Uses edge existence to limit search space.
 */
function generateRectangleLoops(zones, zoneEdges, graph, axes, anchors) {
  const routes = [];

  // Build adjacency list
  const adj = new Map();
  for (const [key] of zoneEdges) {
    const [iStr, jStr] = key.split('-');
    const i = Number(iStr);
    const j = Number(jStr);
    if (!adj.has(i)) adj.set(i, new Set());
    adj.get(i).add(j);
  }

  for (let a = 0; a < zones.length; a++) {
    const aNeighbors = adj.get(a);
    if (!aNeighbors) continue;

    for (const b of aNeighbors) {
      if (b <= a) continue;
      const bNeighbors = adj.get(b);
      if (!bNeighbors) continue;

      for (const c of bNeighbors) {
        if (c <= b) continue;
        const cNeighbors = adj.get(c);
        if (!cNeighbors) continue;

        for (const d of cNeighbors) {
          if (d <= c) continue;
          // Need edge d -> a to close the loop
          if (!zoneEdges.has(`${d}-${a}`) && !zoneEdges.has(`${a}-${d}`)) continue;

          const edgeAB = zoneEdges.get(`${a}-${b}`);
          const edgeBC = zoneEdges.get(`${b}-${c}`);
          const edgeCD = zoneEdges.get(`${c}-${d}`);
          const edgeDA = zoneEdges.get(`${d}-${a}`) ?? zoneEdges.get(`${a}-${d}`);
          if (!edgeAB || !edgeBC || !edgeCD || !edgeDA) continue;

          // Total distance: 10-50km
          const totalDist = edgeAB.distM + edgeBC.distM + edgeCD.distM + edgeDA.distM;
          if (totalDist < 10000 || totalDist > 50000) continue;

          // Check quadrant spread
          if (!hasQuadrantSpread(zones, [a, b, c, d])) continue;

          // Concatenate segment paths
          const edgeDAPath = zoneEdges.has(`${d}-${a}`) ? zoneEdges.get(`${d}-${a}`).segPath : [...zoneEdges.get(`${a}-${d}`).segPath].reverse();
          const fullSegPath = [...edgeAB.segPath, ...edgeBC.segPath, ...edgeCD.segPath, ...edgeDAPath];

          // Convert to axis chain
          const axisChain = segmentsToAxisChain(fullSegPath, graph, axes);
          if (axisChain.length === 0) continue;

          // Find anchor near zone a (loop start/end)
          const anchor = nearestAnchorToZone(zones[a], anchors);
          if (!anchor) continue;

          // Build loop route
          const route = buildRoute(axisChain, anchor, anchor, anchors);
          if (!route) continue;

          const zoneIndices = [a, b, c, d];
          route.zoneInterest = scoreZoneInterest(zones, zoneIndices, zoneEdges, new Set(), new Set(), fullSegPath, graph.segments);
          route.source = 'zone-rectangle';
          routes.push(route);
        }
      }
    }
  }

  console.log(`[zone-routes] ${routes.length} rectangle loops`);
  return routes;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate all zone-based routes.
 *
 * @param {Array} zones - detected zones
 * @param {Map} zoneEdges - zone graph from buildZoneGraph()
 * @param {{ repulsionCells: Set, treeCells: Set }} zoneData - extra zone data
 * @param {object} graph - segment graph from buildSegmentGraph()
 * @param {Array} axes - axes from detectAxes()
 * @param {Array} anchors - scored anchors
 * @returns {Array} combined routes
 */
export function generateZoneRoutes(zones, zoneEdges, zoneData, graph, axes, anchors) {
  const oneWay = generateOneWayRoutes(zones, zoneEdges, graph, axes, anchors);
  const triangles = generateTriangleLoops(zones, zoneEdges, graph, axes, anchors);
  const rectangles = generateRectangleLoops(zones, zoneEdges, graph, axes, anchors);

  const all = [...oneWay, ...triangles, ...rectangles];
  console.log(`[zone-routes] ${all.length} total zone routes (${oneWay.length} one-way, ${triangles.length} triangles, ${rectangles.length} rectangles)`);

  return all;
}
