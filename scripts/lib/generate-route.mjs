/**
 * Core route generation logic — shared between the generate script and tests.
 *
 * Given a route's frontmatter waypoints, resolves them, fills gaps, chains
 * paths, and returns segments. Does NOT write to disk.
 *
 * This is the single source of truth for how routes are generated. The
 * generate script calls this and writes GPX. Tests call this and assert
 * on the segments in memory. No divergence.
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { queryOverpass } from './overpass.mjs';
import { haversineM } from './geo.mjs';
import { orderWays } from './order-ways.mjs';
import { chainBikePaths } from './chain-bike-paths.mjs';
import { resolveWaypoints } from './resolve-waypoints.mjs';
import { planRoute } from './plan-route.mjs';
import { filterCyclingWays } from './filter-cycling-ways.mjs';
import { slugify } from './slugify.mjs';

// ---------------------------------------------------------------------------
// Overpass fetch helpers
// ---------------------------------------------------------------------------

async function fetchRelationWays(relationId) {
  const query = `[out:json][timeout:60];
relation(${relationId});
way(r);
out geom;`;
  const data = await queryOverpass(query);
  return data.elements.filter(e => e.type === 'way' && e.geometry?.length >= 2);
}

async function fetchNamedWays(osmNames, anchors) {
  const lats = anchors.map(a => a[1]);
  const lngs = anchors.map(a => a[0]);
  const pad = 0.02;
  const s = Math.min(...lats) - pad;
  const n = Math.max(...lats) + pad;
  const w = Math.min(...lngs) - pad;
  const e = Math.max(...lngs) + pad;

  const nameFilters = osmNames.map(name =>
    `way["name"="${name.replace(/"/g, '\\"')}"](${s},${w},${n},${e});`
  ).join('\n');

  const query = `[out:json][timeout:60];
(
${nameFilters}
);
out geom;`;
  const data = await queryOverpass(query);
  return data.elements.filter(el =>
    el.type === 'way' && el.geometry?.length >= 2
  );
}

/**
 * Fetch OSM ways for a bike path entry from bikepaths.yml.
 * Handles relations, named ways, park-snap, and cycling filtering.
 */
export async function fetchBikePathWays(bp) {
  let ways = [];
  if (bp.osm_relations?.length > 0) {
    for (const relId of bp.osm_relations) {
      const relWays = await fetchRelationWays(relId);
      ways.push(...relWays);
    }
  } else if (bp.osm_names?.length > 0 && bp.anchors?.length >= 2) {
    ways = await fetchNamedWays(bp.osm_names, bp.anchors);
  } else if (bp.anchors?.length >= 2) {
    ways = await fetchNamedWays([bp.name], bp.anchors);
  }

  ways = filterCyclingWays(ways);

  // Park-snap: if filtering left only park polygons, find cycleways that
  // actually run through the park — not everything in the bounding box.
  if (ways.length > 0 && ways.every(w => w.tags?.leisure === 'park')) {
    // Collect all park polygon points for proximity testing
    const parkPoints = [];
    for (const w of ways) {
      for (const p of w.geometry) parkPoints.push([p.lon, p.lat]);
    }

    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const [lng, lat] of parkPoints) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    const pad = 0.001;
    const q = `[out:json][timeout:30];
(
  way["highway"="cycleway"](${minLat - pad},${minLng - pad},${maxLat + pad},${maxLng + pad});
  way["highway"="path"]["bicycle"~"designated|yes"](${minLat - pad},${minLng - pad},${maxLat + pad},${maxLng + pad});
);
out geom;`;
    try {
      const data = await queryOverpass(q);
      // Only keep cycleways that have at least one point within 50m of a park polygon point
      const cycleways = data.elements.filter(e => {
        if (e.type !== 'way' || !e.geometry?.length || e.geometry.length < 2) return false;
        for (const p of e.geometry) {
          for (const pp of parkPoints) {
            if (haversineM([p.lon, p.lat], pp) < 50) return true;
          }
        }
        return false;
      });
      if (cycleways.length > 0) {
        ways = cycleways;
      }
    } catch { /* keep park ways as fallback */ }
  }

  return ways.length > 0 ? orderWays(ways) : [];
}

/**
 * Insert short connector paths at path→path junctions.
 */
function insertConnectors(planned, allPaths) {
  const result = [];

  for (let i = 0; i < planned.length; i++) {
    result.push(planned[i]);

    if (!Array.isArray(planned[i])) continue;

    // Find the place between this path and the next path (if any)
    // The place is where the transition happens — use it as the junction reference
    let placeCoord = null;
    let nextPathIdx = -1;
    for (let j = i + 1; j < planned.length; j++) {
      if (!Array.isArray(planned[j]) && planned[j].lat != null) {
        placeCoord = [planned[j].lng, planned[j].lat];
      }
      if (Array.isArray(planned[j])) { nextPathIdx = j; break; }
    }
    if (nextPathIdx < 0 || !placeCoord) continue;

    // Search for short connector paths near the place waypoint
    let bestConnector = null;
    let bestScore = Infinity;

    const leftWays = planned[i];
    const rightWays = planned[nextPathIdx];

    for (const bp of allPaths) {
      if (bp.ways === leftWays || bp.ways === rightWays) continue;

      const coords = waysToRenderedCoords(bp.ways);
      // Only short paths (<1.5km)
      let pathLen = 0;
      for (let k = 1; k < coords.length; k++) pathLen += haversineM(coords[k - 1], coords[k]);
      if (pathLen > 1500) continue;

      // Must be near the place (<500m)
      let nearPlace = Infinity;
      for (const c of coords) {
        const d = haversineM(c, placeCoord);
        if (d < nearPlace) nearPlace = d;
      }
      if (nearPlace > 500) continue;

      // Must also be near both paths
      const leftCoords = waysToRenderedCoords(leftWays);
      const rightCoords = waysToRenderedCoords(rightWays);
      let nearLeft = Infinity, nearRight = Infinity;
      for (const c of coords) {
        for (let li = 0; li < leftCoords.length; li += Math.max(1, Math.floor(leftCoords.length / 50))) {
          const d = haversineM(c, leftCoords[li]);
          if (d < nearLeft) nearLeft = d;
        }
        for (let ri = 0; ri < rightCoords.length; ri += Math.max(1, Math.floor(rightCoords.length / 50))) {
          const d = haversineM(c, rightCoords[ri]);
          if (d < nearRight) nearRight = d;
        }
      }

      const score = nearPlace + nearLeft + nearRight;
      if (score < bestScore && nearLeft < 500 && nearRight < 500) {
        bestScore = score;
        bestConnector = bp;
      }
    }

    if (bestConnector) {
      // Mark connector ways so backtrack removal doesn't drop them
      const connectorWays = bestConnector.ways.map(w => ({ ...w, _connector: true }));
      result.push(connectorWays);
    }
  }

  return result;
}

function waysToRenderedCoords(ways) {
  const coords = [];
  for (const w of ways) {
    const g = w.geometry.map(p => [p.lon, p.lat]);
    const trace = w._reversed ? [...g].reverse() : g;
    for (const c of trace) coords.push(c);
  }
  return coords;
}

/**
 * Generate a route from frontmatter waypoints.
 *
 * @param {Object} options
 * @param {Array} options.waypoints - from route frontmatter
 * @param {string} options.dataDir - path to city data dir (e.g. .../santiago)
 * @param {Array} options.bikePaths - parsed bike_paths from bikepaths.yml
 * @returns {Promise<{ segments, chainWaypoints, resolved }>}
 */
export async function generateRoute({ waypoints, dataDir, bikePaths }) {
  const bpBySlug = new Map();
  for (const bp of bikePaths) {
    bpBySlug.set(slugify(bp.name), bp);
  }

  const placesDir = path.join(dataDir, 'places');

  const { chainWaypoints, resolved } = await resolveWaypoints(waypoints, async (bpSlug) => {
    const bp = bpBySlug.get(bpSlug);
    if (!bp) return null;
    const ways = await fetchBikePathWays(bp);
    if (ways.length === 0) return null;
    return ways;
  }, {
    resolvePlace: (placeSlug) => {
      const placePath = path.join(placesDir, placeSlug + '.md');
      if (!fs.existsSync(placePath)) return null;
      const raw = fs.readFileSync(placePath, 'utf8');
      const match = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return null;
      const pm = yaml.load(match[1]);
      if (pm.lat == null || pm.lng == null) return null;
      return { name: pm.name || placeSlug, lat: pm.lat, lng: pm.lng };
    },
    queryOsmName: async (slug) => {
      const name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      let configLat = -33.45, configLng = -70.65;
      try {
        const config = yaml.load(fs.readFileSync(path.join(dataDir, 'config.yml'), 'utf8'));
        if (config?.lat) configLat = config.lat;
        if (config?.lng) configLng = config.lng;
      } catch { /* use defaults */ }
      const pad = 0.15;
      const q = `[out:json][timeout:30];way["name"~"${name.replace(/"/g, '\\"')}",i](${configLat-pad},${configLng-pad},${configLat+pad},${configLng+pad});out geom;`;
      try {
        const data = await queryOverpass(q);
        const ways = data.elements.filter(el =>
          el.type === 'way' && el.geometry?.length >= 2
        );
        if (ways.length > 0) {
          // Filter to cycling infrastructure when available.
          // Streets like "Luis Thayer Ojeda" return dozens of road
          // segments; keeping them all creates a messy polyline that
          // causes zigzag when merged with adjacent paths. Filtering
          // keeps only cycleways/bike lanes, producing a cleaner trace.
          // If no cycling infrastructure exists, fall back to all ways.
          const filtered = filterCyclingWays(ways);
          const ordered = orderWays(filtered.length > 0 ? filtered : ways);
          return ordered;
        }
        const nodes = data.elements.filter(el => el.type === 'node' && el.lat != null);
        if (nodes.length > 0) {
          return { name, lat: nodes[0].lat, lng: nodes[0].lon };
        }
      } catch { /* skip */ }
      return null;
    },
  });

  if (chainWaypoints.length === 0) {
    return { segments: [[]], chainWaypoints: [], resolved: [] };
  }

  // Classify for gap filling
  const classified = chainWaypoints.map(wp => {
    if (Array.isArray(wp)) return { type: 'path', ways: wp };
    return { type: 'place', coord: [wp.lng, wp.lat] };
  });

  // Fill gaps between consecutive places
  let hasGaps = false;
  for (let i = 0; i < classified.length - 1; i++) {
    if (classified[i].type === 'place' && classified[i + 1].type === 'place') {
      hasGaps = true;
      break;
    }
  }

  // Also check for path→place→path junctions that need connectors
  let hasJunctions = false;
  for (let i = 0; i < classified.length - 2; i++) {
    if (classified[i].type === 'path' && classified[i + 1].type === 'place' && classified[i + 2].type === 'path') {
      hasJunctions = true;
      break;
    }
  }

  let finalWaypoints = chainWaypoints;
  let allPathsCache = null;

  if (hasGaps || hasJunctions) {
    allPathsCache = [];
    for (const [bpSlug, bp] of bpBySlug.entries()) {
      const ways = await fetchBikePathWays(bp);
      if (ways.length > 0) allPathsCache.push({ slug: bpSlug, ways });
    }
    if (hasGaps) {
      finalWaypoints = planRoute(classified, allPathsCache);
    }
  }

  // Insert short connector paths at path→path junctions.
  // Short bike paths (<1km) exist at intersections for a reason — they
  // bridge transitions between longer paths. Insert them even if the
  // longer paths technically meet, because the connector provides a
  // smoother, more natural transition.
  if (allPathsCache) {
    finalWaypoints = insertConnectors(finalWaypoints, allPathsCache);
  }

  const segments = chainBikePaths(finalWaypoints);
  return { segments, chainWaypoints, resolved };
}
