/**
 * Waypoint resolution — maps curator-defined waypoints to zones or
 * virtual zones created from POIs/axes.
 *
 * Resolution order:
 *   1. Zone name match (detected zones)
 *   2. POI/anchor name match → virtual zone around the POI
 *   3. Axis name match → virtual zone around the axis centroid
 *   4. Coordinate match → nearest zone
 *
 * Waypoint formats:
 *   - "Río Mapocho"           → string name match
 *   - [-70.6398, -33.4378]    → coordinate [lng, lat] → nearest zone
 *   - { name, lat, lng }      → try name, fallback to coord
 *
 * All coordinates are [lng, lat] (GeoJSON order).
 */

import { haversineM } from './geo.mjs';

const ZONE_GRID = 0.002;

function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

function matchByName(name, items, getName) {
  const n = normalize(name);
  // Exact match
  let match = items.find((item) => normalize(getName(item)) === n);
  if (match) return match;
  // Substring: waypoint contained in item name or vice versa
  match = items.find((item) => {
    const itemN = normalize(getName(item));
    return itemN.includes(n) || n.includes(itemN);
  });
  return match || null;
}

/**
 * Create a virtual zone from a coordinate — a single 200m cell.
 */
function virtualZone(name, coord) {
  const cells = new Set();
  cells.add(`${Math.floor(coord[0] / ZONE_GRID)},${Math.floor(coord[1] / ZONE_GRID)}`);
  return { name, type: 'waypoint', magnetism: 7, centerCoord: coord, cells };
}

function nearestZone(coord, zones) {
  let best = null, bestDist = 3000;
  for (const z of zones) {
    const d = haversineM(coord, z.centerCoord);
    if (d < bestDist) { bestDist = d; best = z; }
  }
  return best;
}

/**
 * Resolve a single waypoint. Tries zones, then anchors, then axes, then coordinates.
 *
 * @param {any} waypoint - string, [lng,lat], or {name, lat, lng}
 * @param {Zone[]} zones - detected zones
 * @param {object} [extras] - { anchors, axes } for fallback matching
 * @returns {Zone | null}
 */
export function resolveWaypoint(waypoint, zones, extras = {}) {
  const { anchors = [], axes = [] } = extras;

  if (typeof waypoint === 'string') {
    // 1. Zone name match
    const zone = matchByName(waypoint, zones, (z) => z.name);
    if (zone) return zone;

    // 2. POI/anchor name match → virtual zone
    const anchor = matchByName(waypoint, anchors, (a) => a.name);
    if (anchor) return virtualZone(anchor.name, [anchor.lng, anchor.lat]);

    // 3. Axis name match → virtual zone at axis centroid
    const axis = matchByName(waypoint, axes, (a) => a.name || '');
    if (axis && axis.segments && axis.segments.length > 0) {
      const segs = axis.segments;
      const cx = segs.reduce((s, seg) => s + seg.centroid[0], 0) / segs.length;
      const cy = segs.reduce((s, seg) => s + seg.centroid[1], 0) / segs.length;
      return virtualZone(axis.name, [cx, cy]);
    }

    // 4. Last resort: nearest zone to nothing — can't resolve a bare string
    return null;
  }

  if (Array.isArray(waypoint) && waypoint.length === 2) {
    // Coordinate → nearest zone, or virtual zone at that point
    const zone = nearestZone(waypoint, zones);
    if (zone) return zone;
    return virtualZone('waypoint', waypoint);
  }

  if (waypoint && typeof waypoint === 'object') {
    if (waypoint.name) {
      const result = resolveWaypoint(waypoint.name, zones, extras);
      if (result) return result;
    }
    if (waypoint.lat != null && waypoint.lng != null) {
      const coord = [waypoint.lng, waypoint.lat];
      const zone = nearestZone(coord, zones);
      if (zone) return zone;
      return virtualZone(waypoint.name || 'waypoint', coord);
    }
  }

  return null;
}

/**
 * Resolve an array of waypoints.
 * @returns {{ resolved: Zone[], unresolved: string[] }}
 */
export function resolveWaypoints(waypointList, zones, extras = {}) {
  const resolved = [];
  const unresolved = [];
  for (const wp of waypointList) {
    const zone = resolveWaypoint(wp, zones, extras);
    if (zone) resolved.push(zone);
    else unresolved.push(typeof wp === 'string' ? wp : JSON.stringify(wp));
  }
  return { resolved, unresolved };
}
