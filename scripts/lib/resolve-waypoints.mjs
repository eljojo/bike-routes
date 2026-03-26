/**
 * Resolve a route's waypoints list into chainBikePaths input.
 * Bike path slugs → Array<way>, place objects → pass through.
 *
 * @param {Array} waypoints - mixed: strings (bike path slugs) and objects ({ name, lat, lng })
 * @param {Function} fetchWays - async (slug) => Array<way> — resolves a slug to ordered ways
 * @returns {Promise<{ chainWaypoints: Array, resolved: Array<string> }>}
 */
export async function resolveWaypoints(waypoints, fetchWays) {
  const chainWaypoints = [];
  const resolved = [];

  for (const wp of waypoints) {
    // Bike path slug (string)
    if (typeof wp === 'string') {
      const ways = await fetchWays(wp);
      if (ways && ways.length > 0) {
        chainWaypoints.push(ways);
        resolved.push(wp);
      }
      continue;
    }

    // Place waypoint ({ name, lat, lng })
    if (typeof wp === 'object' && wp.lat != null && wp.lng != null) {
      chainWaypoints.push(wp);
      resolved.push(wp.name || 'place');
      continue;
    }
  }

  return { chainWaypoints, resolved };
}
