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
          const ordered = orderWays(ways);
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

  let finalWaypoints = chainWaypoints;
  if (hasGaps) {
    const allPaths = [];
    for (const [bpSlug, bp] of bpBySlug.entries()) {
      const ways = await fetchBikePathWays(bp);
      if (ways.length > 0) allPaths.push({ slug: bpSlug, ways });
    }
    finalWaypoints = planRoute(classified, allPaths);
  }

  const segments = chainBikePaths(finalWaypoints);
  return { segments, chainWaypoints, resolved };
}
