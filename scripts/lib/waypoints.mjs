/**
 * Waypoint resolution — maps curator-defined waypoints to detected zones.
 *
 * Waypoint formats:
 *   - "Río Mapocho"           → string name match
 *   - [-70.6398, -33.4378]    → coordinate [lng, lat] → nearest zone
 *   - { name, lat, lng }      → try name, fallback to coord
 *
 * All coordinates are [lng, lat] (GeoJSON order).
 */

import { haversineM } from './geo.mjs';

/**
 * Normalize a string for fuzzy matching: lowercase, strip accents, collapse spaces.
 */
function normalize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Match a waypoint name to a zone. Tries exact match first, then substring.
 */
function matchZoneByName(name, zones) {
  const n = normalize(name);
  // Exact normalized name match
  let match = zones.find((z) => normalize(z.name) === n);
  if (match) return match;
  // Substring: waypoint name contained in zone name or vice versa
  match = zones.find(
    (z) => normalize(z.name).includes(n) || n.includes(normalize(z.name)),
  );
  return match || null;
}

/**
 * Find nearest zone to a [lng, lat] coordinate, within 2km.
 */
function nearestZone(coord, zones) {
  let best = null;
  let bestDist = 2000;
  for (const z of zones) {
    const d = haversineM(coord, z.centerCoord);
    if (d < bestDist) {
      bestDist = d;
      best = z;
    }
  }
  return best;
}

/**
 * Resolve a single waypoint to a zone.
 */
export function resolveWaypoint(waypoint, zones) {
  if (typeof waypoint === 'string') return matchZoneByName(waypoint, zones);
  if (Array.isArray(waypoint) && waypoint.length === 2)
    return nearestZone(waypoint, zones);
  if (waypoint && typeof waypoint === 'object') {
    if (waypoint.name) {
      const match = matchZoneByName(waypoint.name, zones);
      if (match) return match;
    }
    if (waypoint.lat != null && waypoint.lng != null) {
      return nearestZone([waypoint.lng, waypoint.lat], zones);
    }
  }
  return null;
}

/**
 * Resolve an array of waypoints. Returns { resolved: Zone[], unresolved: string[] }
 */
export function resolveWaypoints(waypointList, zones) {
  const resolved = [];
  const unresolved = [];
  for (const wp of waypointList) {
    const zone = resolveWaypoint(wp, zones);
    if (zone) resolved.push(zone);
    else unresolved.push(typeof wp === 'string' ? wp : JSON.stringify(wp));
  }
  return { resolved, unresolved };
}
