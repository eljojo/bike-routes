/**
 * Template route builder — constructs routes from curator-defined zone sequences.
 *
 * For each consecutive zone pair, finds the path via the zone graph.
 * Falls back to reverse-direction lookup if the forward edge isn't found.
 *
 * All coordinates are [lng, lat] (GeoJSON order).
 */

import { haversineM } from './geo.mjs';
import { buildRoute, segmentsToAxisChain } from './trips.mjs';

/**
 * Build a route from a curator's waypoint zone sequence.
 *
 * @param {Zone[]} zoneSequence - ordered zones from resolved waypoints
 * @param {Map} zoneEdges - from buildZoneGraph
 * @param {object} graph - segment graph (with .segments, .edges)
 * @param {Axis[]} axes
 * @param {Anchor[]} anchors
 * @param {object} opts - { routeName }
 * @returns {{ route: Route, segPath: number[] } | null}
 */
export function buildTemplateRoute(
  zoneSequence,
  zoneEdges,
  graph,
  axes,
  anchors,
  opts = {},
) {
  if (zoneSequence.length < 2) return null;

  const fullSegPath = [];

  for (let i = 0; i < zoneSequence.length - 1; i++) {
    const fromZone = zoneSequence[i];
    const toZone = zoneSequence[i + 1];

    // Find an edge whose segment path connects these two zones.
    // Zone graph edges are keyed by index pairs — we match by checking
    // whether the path's start/end segments are near the zone centers.
    let edge = findEdgeBetween(fromZone, toZone, zoneEdges, graph);

    if (edge && edge.segPath) {
      fullSegPath.push(...edge.segPath);
    } else {
      console.warn(
        `[template] No path between "${fromZone.name}" and "${toZone.name}"`,
      );
      return null;
    }
  }

  if (fullSegPath.length === 0) return null;

  // Convert to axis chain
  const axisChain = segmentsToAxisChain(fullSegPath, graph, axes);
  if (axisChain.length === 0) return null;

  // Find anchors near first/last zone
  const startAnchor = findNearestAnchor(
    zoneSequence[0].centerCoord,
    anchors,
  );
  const endAnchor = findNearestAnchor(
    zoneSequence[zoneSequence.length - 1].centerCoord,
    anchors,
  );
  if (!startAnchor || !endAnchor) return null;

  const route = buildRoute(axisChain, startAnchor, endAnchor, anchors);
  return route ? { route, segPath: fullSegPath } : null;
}

/**
 * Search zone edges for a path connecting two zones.
 * Checks forward and reverse directions.
 */
function findEdgeBetween(fromZone, toZone, zoneEdges, graph) {
  for (const [, e] of zoneEdges) {
    if (!e.segPath || e.segPath.length === 0) continue;

    const pathStart = graph.segments[e.segPath[0]].centroid;
    const pathEnd = graph.segments[e.segPath[e.segPath.length - 1]].centroid;

    // Forward: path goes from fromZone to toZone
    if (
      haversineM(fromZone.centerCoord, pathStart) < 2000 &&
      haversineM(toZone.centerCoord, pathEnd) < 2000
    ) {
      return e;
    }

    // Reverse: path goes from toZone to fromZone — reverse the segment path
    if (
      haversineM(toZone.centerCoord, pathStart) < 2000 &&
      haversineM(fromZone.centerCoord, pathEnd) < 2000
    ) {
      return { ...e, segPath: [...e.segPath].reverse() };
    }
  }
  return null;
}

/**
 * Find the nearest anchor to a coordinate, within 3km.
 */
function findNearestAnchor(coord, anchors) {
  let best = null;
  let bestDist = 3000;
  for (const a of anchors) {
    const d = haversineM(coord, [a.lng, a.lat]);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  return best;
}
