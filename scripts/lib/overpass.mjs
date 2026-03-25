/**
 * Overpass API client with file-based caching.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '.cache');

// Try alternative servers if main is rate-limited.
// private.coffee has no rate limit and 4 servers with 256GB RAM each.
const OVERPASS_SERVERS = [
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];
const OVERPASS_URL = process.env.OVERPASS_URL || OVERPASS_SERVERS[0];

function cacheKey(query) {
  const hash = createHash('sha256').update(query).digest('base64url');
  return hash.slice(0, 40);
}

/**
 * POST a query to Overpass, caching results to disk.
 * Returns parsed JSON response.
 */
export async function queryOverpass(query) {
  mkdirSync(CACHE_DIR, { recursive: true });

  const key = cacheKey(query);
  const cachePath = join(CACHE_DIR, `overpass-${key}.json`);

  if (existsSync(cachePath)) {
    console.log(`[overpass] cache hit: ${key}`);
    return JSON.parse(readFileSync(cachePath, 'utf8'));
  }

  console.log(`[overpass] fetching from API (key: ${key})`);

  let data;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });

    if (res.ok) {
      data = await res.json();
      break;
    }

    if (res.status === 504 || res.status === 429) {
      const wait = (attempt + 1) * 15;
      console.log(`[overpass] server busy (${res.status}), retrying in ${wait}s...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }

    throw new Error(`Overpass API error ${res.status}: ${await res.text()}`);
  }

  if (!data) throw new Error('Overpass API: failed after 3 retries');
  writeFileSync(cachePath, JSON.stringify(data), 'utf8');
  console.log(`[overpass] cached ${data.elements?.length ?? 0} elements to ${key}`);
  return data;
}

/**
 * Fetch points of interest within a bounding box.
 * @param {[number, number, number, number]} bounds - [south, west, north, east]
 * @returns {Array<{ name, lat, lng, type, osmType, osmId, tags }>}
 */
export async function fetchPOIs(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;

  // POI types that matter for cycling: destinations worth riding to,
  // places to stop, and cycling-specific infrastructure.
  // Modeled after the curated places in Ottawa (128 hand-picked spots).
  const query = `
[out:json][timeout:180];
(
  // Parks, gardens, beaches — primary ride destinations
  way["leisure"="park"](${bbox});
  node["leisure"="park"](${bbox});
  way["leisure"="garden"]["name"](${bbox});
  node["natural"="beach"](${bbox});
  way["natural"="beach"](${bbox});

  // Viewpoints, squares, plazas — scenic stops
  node["tourism"="viewpoint"](${bbox});
  node["place"="square"](${bbox});
  way["place"="square"](${bbox});

  // Food & drink — where cyclists refuel
  node["amenity"="cafe"]["name"](${bbox});
  node["amenity"="ice_cream"]["name"](${bbox});
  node["amenity"="pub"]["name"](${bbox});
  node["amenity"="marketplace"](${bbox});
  way["amenity"="marketplace"](${bbox});

  // Cycling infrastructure
  node["amenity"="bicycle_rental"](${bbox});
  node["shop"="bicycle"](${bbox});

  // Transport hubs
  node["railway"="station"](${bbox});
  node["amenity"="ferry_terminal"](${bbox});

  // Camping (for longer rides)
  node["tourism"="camp_site"]["name"](${bbox});
  way["tourism"="camp_site"]["name"](${bbox});

  // Culture
  node["tourism"="museum"]["name"](${bbox});
  way["tourism"="museum"]["name"](${bbox});
  way["natural"="water"]["name"](${bbox});

  // Bridges — river crossings make rides memorable
  way["bridge"="yes"]["name"]["highway"~"cycleway|path|footway|pedestrian"](${bbox});
  way["man_made"="bridge"]["name"](${bbox});
);
out center tags;
`.trim();

  const data = await queryOverpass(query);

  const results = [];
  for (const el of data.elements ?? []) {
    // Extract lat/lng — ways have center, nodes have direct coords
    let lat, lng;
    if (el.center) {
      lat = el.center.lat;
      lng = el.center.lon;
    } else if (el.lat != null) {
      lat = el.lat;
      lng = el.lon;
    }

    if (lat == null || lng == null) continue;

    const tags = el.tags ?? {};
    const name = tags.name;
    if (!name) continue;

    // Determine type from first matching tag
    let type = null;
    if (tags.bridge || tags.man_made === 'bridge') type = 'bridge';
    else if (tags.leisure) type = tags.leisure;
    else if (tags.tourism) type = tags.tourism;
    else if (tags.amenity) type = tags.amenity;
    else if (tags.place) type = tags.place;
    else if (tags.railway) type = tags.railway;
    else if (tags.natural) type = tags.natural;

    if (!type) continue;

    results.push({
      name,
      lat,
      lng,
      type,
      osmType: el.type,
      osmId: el.id,
      tags,
    });
  }

  return results;
}

/**
 * Fetch cycling infrastructure ways within a bounding box.
 * @param {[number, number, number, number]} bounds - [south, west, north, east]
 * @returns {Array} OSM way elements with geometry (length >= 2 nodes)
 */
export async function fetchCyclingWays(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;

  const query = `
[out:json][timeout:60];
(
  way["highway"="cycleway"](${bbox});
  way["cycleway"~"track|lane|shared_lane"](${bbox});
  way["cycleway:left"~"track|lane"](${bbox});
  way["cycleway:right"~"track|lane"](${bbox});
  way["bicycle"="designated"]["highway"~"path|footway"](${bbox});
);
out geom tags;
`.trim();

  const data = await queryOverpass(query);

  return (data.elements ?? []).filter(
    (el) => Array.isArray(el.geometry) && el.geometry.length >= 2,
  );
}

/**
 * Fetch metro/light-rail stations within a bounding box.
 * @param {[number, number, number, number]} bounds - [south, west, north, east]
 * @returns {Array<{ name, lat, lng, type, osmType, osmId, tags }>}
 */
export async function fetchMetroStations(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const query = `
[out:json][timeout:30];
(
  node["railway"="station"]["station"="subway"](${bbox});
  node["railway"="station"]["station"="light_rail"](${bbox});
);
out tags;
`.trim();

  const data = await queryOverpass(query);
  return (data.elements ?? [])
    .filter((el) => el.tags?.name)
    .map((el) => ({
      name: el.tags.name,
      lat: el.lat,
      lng: el.lon,
      type: 'metro',
      osmType: el.type,
      osmId: el.id,
      tags: el.tags,
    }));
}

/**
 * Fetch named rivers and canals within a bounding box.
 * @param {[number, number, number, number]} bounds - [south, west, north, east]
 * @returns {Array<{ name, geometry }>} geometry is array of [lon, lat] pairs
 */
export async function fetchWaterways(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const query = `
[out:json][timeout:30];
(
  way["waterway"="river"]["name"](${bbox});
  way["waterway"="canal"]["name"](${bbox});
);
out geom tags;
`.trim();

  const data = await queryOverpass(query);
  return (data.elements ?? [])
    .filter((el) => Array.isArray(el.geometry) && el.geometry.length >= 2)
    .map((el) => ({
      name: el.tags.name,
      geometry: el.geometry.map(({ lat, lon }) => [lon, lat]),
    }));
}

/**
 * Fetch all rideable roads within a bounding box for gap routing.
 * @param {[number, number, number, number]} bounds - [south, west, north, east]
 * @returns {Array} OSM way elements with geometry
 */
export async function fetchRoadNetwork(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const query = `
[out:json][timeout:90];
(
  way["highway"~"cycleway|path|footway|residential|tertiary|secondary|unclassified|living_street|pedestrian|service"](${bbox});
);
out geom;
`.trim();

  const data = await queryOverpass(query);
  return (data.elements ?? [])
    .filter(el => Array.isArray(el.geometry) && el.geometry.length >= 2);
}

/**
 * Fetch motorway/trunk/motorway_link ways within a bounding box.
 * @param {[number, number, number, number]} bounds - [south, west, north, east]
 * @returns {Array<Array<[number, number]>>} array of coordinate arrays ([lon, lat] pairs)
 */
export async function fetchMotorways(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const query = `
[out:json][timeout:30];
(
  way["highway"="motorway"](${bbox});
  way["highway"="trunk"](${bbox});
  way["highway"="motorway_link"](${bbox});
);
out geom;
`.trim();

  const data = await queryOverpass(query);
  return (data.elements ?? [])
    .filter((el) => Array.isArray(el.geometry) && el.geometry.length >= 2)
    .map((el) => el.geometry.map(({ lat, lon }) => [lon, lat]));
}

/**
 * Fetch all "interesting things" for zone clustering — cast a wide net.
 * @param {[number, number, number, number]} bounds - [south, west, north, east]
 * @returns {Array<{ lat, lng, tags }>}
 */
export async function fetchZonePOIs(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const query = `
[out:json][timeout:120];
(
  node["amenity"~"cafe|restaurant|bar|pub|fast_food|ice_cream|food_court|marketplace|theatre|cinema|arts_centre|biergarten"](${bbox});
  node["shop"~"bakery|deli|wine|chocolate|books"](${bbox});
  node["tourism"~"museum|gallery|viewpoint|attraction|artwork"](${bbox});
  node["leisure"~"beer_garden|playground|swimming_pool"](${bbox});
  node["historic"~"monument|memorial|castle"](${bbox});
);
out;
`.trim();

  const data = await queryOverpass(query);
  return (data.elements ?? [])
    .filter((el) => el.lat != null && el.lon != null)
    .map((el) => ({ lat: el.lat, lng: el.lon, tags: el.tags ?? {} }));
}

/**
 * Fetch tree rows for shade/canopy scoring.
 * @param {[number, number, number, number]} bounds
 * @returns {Array<Array<[number, number]>>} array of coordinate arrays [lon, lat]
 */
export async function fetchTreeRows(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const query = `
[out:json][timeout:30];
way["natural"="tree_row"](${bbox});
out geom;
`.trim();

  const data = await queryOverpass(query);
  return (data.elements ?? [])
    .filter((el) => Array.isArray(el.geometry) && el.geometry.length >= 2)
    .map((el) => el.geometry.map(({ lat, lon }) => [lon, lat]));
}

/**
 * Fetch bike parking racks and rental stations.
 * @param {[number, number, number, number]} bounds
 * @returns {Array<{ lat, lng, type }>}
 */
export async function fetchBikeParking(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const query = `
[out:json][timeout:30];
(
  node["amenity"="bicycle_parking"](${bbox});
  node["amenity"="bicycle_rental"](${bbox});
);
out;
`.trim();

  const data = await queryOverpass(query);
  return (data.elements ?? [])
    .filter((el) => el.lat != null)
    .map((el) => ({ lat: el.lat, lng: el.lon, type: el.tags?.amenity }));
}

/**
 * Fetch park/plaza/garden areas with polygon geometry.
 * Ways get geometry directly; relations have member geometry.
 * @param {[number,number,number,number]} bounds - [south, west, north, east]
 * @returns {Array<{ name, type, lat, lng, geometry, extent, osmType, osmId, tags }>}
 */
export async function fetchParkAreas(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;
  const query = `
[out:json][timeout:90];
(
  way["leisure"~"park|garden"]["name"](${bbox});
  way["place"="square"]["name"](${bbox});
  way["landuse"="recreation_ground"]["name"](${bbox});
  rel["leisure"~"park|garden"]["name"](${bbox});
);
out geom tags;
`.trim();

  const data = await queryOverpass(query);
  const results = [];

  for (const el of data.elements ?? []) {
    const tags = el.tags ?? {};
    const name = tags.name;
    if (!name) continue;

    let coords = [];

    if (el.type === 'way' && Array.isArray(el.geometry)) {
      coords = el.geometry.map((p) => [p.lon, p.lat]);
    } else if (el.type === 'relation' && Array.isArray(el.members)) {
      for (const member of el.members) {
        if (member.role === 'outer' && Array.isArray(member.geometry)) {
          coords.push(...member.geometry.map((p) => [p.lon, p.lat]));
        }
      }
      if (coords.length === 0) {
        for (const member of el.members) {
          if (Array.isArray(member.geometry)) {
            coords.push(...member.geometry.map((p) => [p.lon, p.lat]));
          }
        }
      }
    }

    if (coords.length < 3) continue;

    let sumLng = 0, sumLat = 0;
    for (const [lng, lat] of coords) { sumLng += lng; sumLat += lat; }
    const centerLng = sumLng / coords.length;
    const centerLat = sumLat / coords.length;

    const lats = coords.map((c) => c[1]);
    const lngs = coords.map((c) => c[0]);
    const heightM = (Math.max(...lats) - Math.min(...lats)) * 111320;
    const widthM = (Math.max(...lngs) - Math.min(...lngs)) * 111320 * Math.cos(centerLat * Math.PI / 180);
    const extent = Math.max(widthM, heightM);

    results.push({
      name,
      type: tags.leisure || tags.place || tags.landuse || 'park',
      lat: centerLat,
      lng: centerLng,
      geometry: coords,
      extent: Math.round(extent),
      osmType: el.type,
      osmId: el.id,
      tags,
    });
  }

  console.log(`[overpass] ${results.length} park areas (${results.filter((r) => r.osmType === 'relation').length} relations)`);
  return results;
}
