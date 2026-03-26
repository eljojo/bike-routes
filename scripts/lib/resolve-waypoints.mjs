/**
 * Resolve a route's waypoints list into chainBikePaths input.
 *
 * String waypoints are resolved in order:
 *   1. Try as bike path slug (fetchWays) — returns Array<way>
 *   2. Try as place slug (options.resolvePlace) — returns { name, lat, lng }
 *   3. Try as OSM name query (options.queryOsmName) — search for a way with
 *      that name in OSM, returns Array<way> or { name, lat, lng }
 *   4. Skip if nothing matches (log a warning)
 *
 * Step 3 allows natural directions: "luis-thayer-ojeda" resolves to the street
 * "Luis Thayer Ojeda" in OSM without needing a bikepaths.yml entry or place file.
 *
 * @param {Array} waypoints - mixed: strings and objects ({ name, lat, lng })
 * @param {Function} fetchWays - async (slug) => Array<way> | null
 * @param {Object} [options]
 * @param {Function} [options.resolvePlace] - (slug) => { name, lat, lng } | null
 * @param {Function} [options.queryOsmName] - async (slug) => Array<way> | { lat, lng } | null
 * @returns {Promise<{ chainWaypoints: Array, resolved: Array<string> }>}
 */
export async function resolveWaypoints(waypoints, fetchWays, options = {}) {
  const { resolvePlace, queryOsmName } = options;
  const chainWaypoints = [];
  const resolved = [];

  for (const wp of waypoints) {
    // Place waypoint ({ name, lat, lng })
    if (typeof wp === 'object' && wp.lat != null && wp.lng != null) {
      chainWaypoints.push(wp);
      resolved.push(wp.name || 'place');
      continue;
    }

    // String: try bike path, then place, then OSM name query
    if (typeof wp === 'string') {
      const ways = await fetchWays(wp);
      if (ways && ways.length > 0) {
        chainWaypoints.push(ways);
        resolved.push(wp);
        continue;
      }

      if (resolvePlace) {
        const place = resolvePlace(wp);
        if (place) {
          chainWaypoints.push(place);
          resolved.push(place.name || wp);
          continue;
        }
      }

      if (queryOsmName) {
        const osmResult = await queryOsmName(wp);
        if (osmResult) {
          chainWaypoints.push(osmResult);
          resolved.push(wp + ' (osm)');
          continue;
        }
      }

      console.warn(`[resolve-waypoints] unresolved: ${wp}`);
    }
  }

  return { chainWaypoints, resolved };
}
