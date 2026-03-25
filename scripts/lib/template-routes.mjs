/**
 * Template route builder — builds routes from curator-defined waypoints.
 *
 * Waypoints resolve to axes (corridors), zones, or POIs. The route
 * chains through them using A* on the segment graph.
 *
 * Key insight: a waypoint like "Ciclovía Costanera Sur" is an AXIS
 * (13km of segments), not a point. The route follows that axis's
 * segments, then bridges to the next waypoint via A*.
 */

import { haversineM } from './geo.mjs';
import { aStarSegments } from './zone-graph.mjs';

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ');
}

// Common prefixes that don't carry distinctive meaning.
// "Parque Forestal" and "Ciclovía Parque Forestal" are the same place.
const STRIP_PREFIXES = /^(parque|plaza|ciclovia|avenida|calle|rotonda|camino|estadio|jardin|paseo|ciclo ?recreovia|mirador|puente|entrada|acceso|museo|centro cultural|bandejón central)\s+/i;

/**
 * Extract the distinctive part of a name — strip common type prefixes.
 * "Parque Sánchez Fontecilla" → "sanchez fontecilla"
 * "Ciclovía Andrés Bello" → "andres bello"
 */
function distinctive(s) {
  let d = normalize(s);
  // Strip prefixes repeatedly (handles "Parque Intercomunal Padre Hurtado")
  for (let i = 0; i < 3; i++) {
    const before = d;
    d = d.replace(STRIP_PREFIXES, '').trim();
    if (d === before) break;
  }
  return d || normalize(s); // fallback to full name if stripping removed everything
}

/**
 * Match two names by their distinctive parts.
 * "Rotonda Pérez Zujovic" matches "Plaza Pérez Zujovic" because
 * both have distinctive part "perez zujovic".
 */
function namesMatch(a, b) {
  const na = normalize(a), nb = normalize(b);
  // Direct substring
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  // Distinctive part match
  const da = distinctive(a), db = distinctive(b);
  if (da.length >= 4 && db.length >= 4 && (da.includes(db) || db.includes(da))) return true;
  return false;
}

/**
 * Resolve a waypoint to segment indices in the graph.
 *
 * Returns { type, name, segIndices (for axes), entryIdx, exitIdx }
 */
function resolveToSegments(waypoint, graph, axes, anchors, zones) {
  const { segments, segToAxis } = graph;
  const name = typeof waypoint === 'string' ? waypoint : waypoint?.name || '';
  const n = normalize(name);

  if (n) {
    // 1. Match axis by name — returns the full corridor
    for (let ai = 0; ai < axes.length; ai++) {
      const axisName = axes[ai].name || '';
      if (!axisName || axisName.length < 3) continue;
      if (namesMatch(name, axisName)) {
        const segIndices = [];
        for (let si = 0; si < segments.length; si++) {
          if (segToAxis.get(si) === ai) segIndices.push(si);
        }
        if (segIndices.length > 0) {
          return { type: 'axis', name: axes[ai].name, segIndices, entryIdx: segIndices[0], exitIdx: segIndices[segIndices.length - 1] };
        }
      }
    }

    // 2. Match zone by name
    if (zones) {
      for (const z of zones) {
        if (z.name && namesMatch(name, z.name)) {
          const nearest = findNearestSeg(z.centerCoord, segments);
          return { type: 'zone', name: z.name, segIndices: [], entryIdx: nearest, exitIdx: nearest };
        }
      }
    }

    // 3. Match anchor/POI by name
    if (anchors) {
      for (const a of anchors) {
        if (a.name && namesMatch(name, a.name)) {
          const nearest = findNearestSeg([a.lng, a.lat], segments);
          return { type: 'poi', name: a.name, segIndices: [], entryIdx: nearest, exitIdx: nearest };
        }
      }
    }
  }

  // 4. Coordinate
  let coord = null;
  if (Array.isArray(waypoint) && waypoint.length === 2) coord = waypoint;
  else if (waypoint?.lat != null && waypoint?.lng != null) coord = [waypoint.lng, waypoint.lat];
  if (coord) {
    const nearest = findNearestSeg(coord, segments);
    return { type: 'coord', name: name || 'waypoint', segIndices: [], entryIdx: nearest, exitIdx: nearest };
  }

  return null;
}

function findNearestSeg(coord, segments) {
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < segments.length; i++) {
    const d = haversineM(coord, segments[i].centroid);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

/**
 * Build a segment path from curator waypoints.
 *
 * For each waypoint:
 * - If it's an axis: include all its segments in the path
 * - Bridge gaps between consecutive waypoints with A*
 *
 * @returns {{ segPath: number[], resolvedNames: string[] } | null}
 */
export function buildTemplatePath(waypoints, graph, axes, anchors, zones) {
  const { segments, edges } = graph;

  const resolved = [];
  const unresolved = [];
  for (const wp of waypoints) {
    const r = resolveToSegments(wp, graph, axes, anchors, zones);
    if (r) {
      resolved.push(r);
    } else {
      unresolved.push(typeof wp === 'string' ? wp : JSON.stringify(wp));
    }
  }

  if (unresolved.length > 0) {
    console.log(`[template] Unresolved: ${unresolved.join(', ')}`);
  }
  if (resolved.length < 2) return null;

  const fullPath = [];
  const resolvedNames = resolved.map(r => `${r.name} (${r.type}${r.segIndices.length > 0 ? ', ' + r.segIndices.length + ' segs' : ''})`);

  for (let i = 0; i < resolved.length; i++) {
    const curr = resolved[i];

    // Bridge from previous endpoint to this waypoint's entry
    if (fullPath.length > 0) {
      const from = fullPath[fullPath.length - 1];
      const to = curr.entryIdx;
      if (from !== to) {
        const bridge = aStarSegments(from, to, segments, edges);
        if (bridge && bridge.path.length > 1) {
          for (let j = 1; j < bridge.path.length; j++) {
            if (bridge.path[j] !== fullPath[fullPath.length - 1]) {
              fullPath.push(bridge.path[j]);
            }
          }
        } else {
          console.log(`[template] No A* path from seg ${from} to seg ${to} (${resolved[i - 1]?.name} → ${curr.name})`);
        }
      }
    }

    // Include axis segments
    if (curr.segIndices.length > 0) {
      for (const si of curr.segIndices) {
        if (fullPath.length === 0 || si !== fullPath[fullPath.length - 1]) {
          fullPath.push(si);
        }
      }
    } else if (fullPath.length === 0) {
      fullPath.push(curr.entryIdx);
    }
  }

  if (fullPath.length < 2) return null;
  return { segPath: fullPath, resolvedNames };
}
