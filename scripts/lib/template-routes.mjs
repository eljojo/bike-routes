/**
 * Template route builder — builds routes from curator-defined waypoints.
 *
 * Waypoints resolve to axes (corridors), zones, or POIs. The route
 * chains through them using A* on the segment graph.
 *
 * Key insight: a waypoint like "Ciclovía Costanera Sur" is an AXIS
 * (13km of segments), not a point. The route follows that axis's
 * segments, then bridges to the next waypoint via A*.
 *
 * Geographic coherence: when a waypoint name matches multiple locations,
 * pick the one closest to the neighboring waypoints. "Laguna Poniente"
 * near the Mapocho beats "Laguna Poniente" in Maipú when the next
 * waypoint is "Ciclovía Mapocho 42k".
 */

import { haversineM } from './geo.mjs';
import { aStarSegments } from './zone-graph.mjs';

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ');
}


function namesMatch(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return true;
  // Substring: the shorter must be at least 8 chars and cover at least
  // 50% of the longer. This handles "Costanera Sur" matching
  // "Ciclovía Costanera Sur" but rejects "Nacional" matching
  // "Librería Nacional" (8/19 = 42%).
  if (na.length >= 8 && nb.length >= 8) {
    const shorter = na.length <= nb.length ? na : nb;
    const longer = na.length <= nb.length ? nb : na;
    if (longer.includes(shorter) && shorter.length / longer.length >= 0.5) return true;
  }
  return false;
}

/**
 * Find ALL matches for a waypoint — not just the first.
 * Returns array of { type, name, coord, segIndices, entryIdx, exitIdx }
 */
function findAllMatches(waypoint, graph, axes, anchors, zones) {
  const { segments, segToAxis } = graph;
  const name = typeof waypoint === 'string' ? waypoint : waypoint?.name || '';
  const matches = [];

  if (name) {
    // 1. Match axes by name
    for (let ai = 0; ai < axes.length; ai++) {
      const axisName = axes[ai].name || '';
      if (!axisName || axisName.length < 3) continue;
      if (namesMatch(name, axisName)) {
        const segIndices = [];
        for (let si = 0; si < segments.length; si++) {
          if (segToAxis.get(si) === ai) segIndices.push(si);
        }
        if (segIndices.length > 0) {
          // Compute center of this axis
          let cx = 0, cy = 0;
          for (const si of segIndices) { cx += segments[si].centroid[0]; cy += segments[si].centroid[1]; }
          cx /= segIndices.length; cy /= segIndices.length;
          matches.push({ type: 'axis', name: axisName, coord: [cx, cy], segIndices, entryIdx: segIndices[0], exitIdx: segIndices[segIndices.length - 1] });
        }
      }
    }

    // 2. Match zones
    if (zones) {
      for (const z of zones) {
        if (z.name && namesMatch(name, z.name)) {
          const nearest = findNearestSeg(z.centerCoord, segments);
          matches.push({ type: 'zone', name: z.name, coord: z.centerCoord, segIndices: [], entryIdx: nearest, exitIdx: nearest });
        }
      }
    }

    // 3. Match POIs/anchors — collect ALL matches, not just first
    if (anchors) {
      for (const a of anchors) {
        if (a.name && namesMatch(name, a.name)) {
          const coord = [a.lng, a.lat];
          const nearest = findNearestSeg(coord, segments);
          matches.push({ type: 'poi', name: a.name, coord, segIndices: [], entryIdx: nearest, exitIdx: nearest });
        }
      }
    }
  }

  // 4. Coordinate
  if (matches.length === 0) {
    let coord = null;
    if (Array.isArray(waypoint) && waypoint.length === 2) coord = waypoint;
    else if (waypoint?.lat != null && waypoint?.lng != null) coord = [waypoint.lng, waypoint.lat];
    if (coord) {
      const nearest = findNearestSeg(coord, segments);
      matches.push({ type: 'coord', name: name || 'waypoint', coord, segIndices: [], entryIdx: nearest, exitIdx: nearest });
    }
  }

  return matches;
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
 * Pick the geographically coherent match for each waypoint.
 *
 * For waypoints with multiple matches, pick the one that minimizes
 * total distance to neighboring waypoints. This ensures "Laguna Poniente"
 * near the Mapocho beats "Laguna Poniente" in Maipú when surrounded
 * by river waypoints.
 */
function pickCoherentMatches(allMatches, segments) {
  // First pass: for waypoints with exactly 1 match, lock them in
  const locked = allMatches.map(m => m.length === 1 ? m[0] : null);

  // Compute rough center from locked matches
  let cx = 0, cy = 0, count = 0;
  for (const m of locked) {
    if (m) { cx += m.coord[0]; cy += m.coord[1]; count++; }
  }
  if (count > 0) { cx /= count; cy /= count; }

  // Second pass: for multi-match waypoints, pick closest to center
  // Then recompute center and repeat
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i < allMatches.length; i++) {
      if (locked[i]) continue;
      if (allMatches[i].length === 0) continue;

      // Score each match by distance to neighbors + distance to center
      let bestMatch = allMatches[i][0];
      let bestScore = Infinity;

      for (const m of allMatches[i]) {
        // For axis matches, use the nearest segment endpoint to each
        // reference point, not the axis center. A 10km corridor is
        // "near" anything along its length, not just its midpoint.
        const distTo = (refCoord) => {
          if (m.type !== 'axis' || m.segIndices.length === 0) {
            return haversineM(m.coord, refCoord);
          }
          let minD = Infinity;
          for (const si of m.segIndices) {
            const seg = segments[si];
            const d = Math.min(
              haversineM(seg.centroid, refCoord),
              haversineM(seg.start || seg.centroid, refCoord),
              haversineM(seg.end || seg.centroid, refCoord),
            );
            if (d < minD) minD = d;
          }
          return minD;
        };

        let score = 0;
        if (count > 0) score += distTo([cx, cy]);
        if (i > 0 && locked[i - 1]) {
          score += distTo(locked[i - 1].coord) * 2;
        }
        if (i < allMatches.length - 1 && locked[i + 1]) {
          score += distTo(locked[i + 1].coord) * 2;
        }
        // Prefer axis > zone > POI. An axis match means "follow this
        // corridor," which is what waypoints like "Ciclovía Mapocho 42k"
        // intend. A POI with the same name is just a nearby point.
        const typeBonus = m.type === 'axis' ? -5000 : m.type === 'zone' ? -2000 : 0;
        score += typeBonus;
        if (score < bestScore) { bestScore = score; bestMatch = m; }
      }

      locked[i] = bestMatch;
    }

    // Recompute center
    cx = 0; cy = 0; count = 0;
    for (const m of locked) {
      if (m) { cx += m.coord[0]; cy += m.coord[1]; count++; }
    }
    if (count > 0) { cx /= count; cy /= count; }
  }

  return locked;
}

/**
 * Build a segment path from curator waypoints.
 * @returns {{ segPath: number[], resolvedNames: string[] } | null}
 */
export function buildTemplatePath(waypoints, graph, axes, anchors, zones) {
  const { segments, edges } = graph;

  // Phase 1: find ALL matches for each waypoint
  const allMatches = [];
  const unresolved = [];
  for (const wp of waypoints) {
    const matches = findAllMatches(wp, graph, axes, anchors, zones);
    allMatches.push(matches);
    if (matches.length === 0) {
      unresolved.push(typeof wp === 'string' ? wp : JSON.stringify(wp));
    }
  }

  if (unresolved.length > 0) {
    console.log(`[template] Unresolved: ${unresolved.join(', ')}`);
  }

  // Phase 2: pick geographically coherent matches
  const resolved = pickCoherentMatches(allMatches, segments);
  const validResolved = resolved.filter(Boolean);
  if (validResolved.length < 2) return null;

  const resolvedNames = resolved.map(r =>
    r ? `${r.name} (${r.type}${r.segIndices.length > 0 ? ', ' + r.segIndices.length + ' segs' : ''})` : '?'
  );

  // Phase 3: chain waypoints via A*
  const fullPath = [];
  for (let i = 0; i < resolved.length; i++) {
    const curr = resolved[i];
    if (!curr) continue;

    // Bridge from previous
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
