#!/usr/bin/env node

/**
 * Build bikepaths.yml — the city's cycling infrastructure registry.
 *
 * Discovers cycling infrastructure from OSM, builds entries from scratch
 * on every run (no incremental merge with existing file), and optionally
 * enriches with network discovery and Wikidata metadata.
 *
 * Region-specific behavior (OSM query patterns, external data sources) is
 * defined in lib/city-adapter.mjs.
 *
 * Usage:
 *   node scripts/build-bikepaths.mjs --city santiago
 *   node scripts/build-bikepaths.mjs --city ottawa --dry-run
 *
 * ## Pipeline
 *
 * 1. loadManualEntries() — read manual-entries.yml sidecar
 * 2. discoverOsmRelations() — OSM relations in bbox
 * 3. discoverOsmNamedWays() — named cycling ways
 * 4. discoverParallelLanes() — unnamed cycleways
 * 5. buildEntries() — build from scratch (NO merge with existing)
 * 6. enrichOutOfBoundsRelations() — for manual entries
 * 7. discoverNetworks() — find superroutes, add network entries
 * 8. autoGroupNearbyPaths() — cluster trails (skipping network members)
 * 9. Centralized slug computation
 * 10. resolveNetworkMembers() — _member_relations → slugs, assign member_of
 * 11. enrichWithWikidata()
 * 12. Write YAML (strip transient fields)
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { queryOverpass as _queryOverpass, createRecorder } from './lib/overpass.mjs';

// Record all Overpass calls to a cassette in .cache/ (gitignored) for test replay.
// Usage: RECORD_OVERPASS=ottawa node scripts/build-bikepaths.mjs --city ottawa
// Replay: createPlayer('ottawa') in tests
const queryOverpass = process.env.RECORD_OVERPASS
  ? createRecorder(process.env.RECORD_OVERPASS)
  : _queryOverpass;
import { haversineM } from './lib/geo.mjs';
import { slugify } from './lib/slugify.mjs';
import { loadCityAdapter } from './lib/city-adapter.mjs';
import { chainSegments } from './lib/chain-segments.mjs';
import { selectBestRoad } from './lib/select-best-road.mjs';
import { defaultParallelLaneFilter } from './lib/city-adapter.mjs';
import { autoGroupNearbyPaths, computeSlugs } from './lib/auto-group.mjs';
import { discoverNetworks, discoverRouteSystemNetworks } from './lib/discover-networks.mjs';
import { enrichWithWikidata } from './lib/wikidata.mjs';
import { detectMtb } from './lib/detect-mtb.mjs';
import { derivePathType } from './lib/path-type.mjs';
import { rankByGeomDistance } from './lib/nearest-park.mjs';

// ---------------------------------------------------------------------------
// CLI (only when run directly, not when imported)
// ---------------------------------------------------------------------------

let args = {}, dataDir, bikepathsPath, bbox, adapter;

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain) {
  args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--city') args.city = process.argv[++i];
    if (process.argv[i] === '--dry-run') args.dryRun = true;
  }
  if (!args.city) {
    console.error('Usage: node scripts/build-bikepaths.mjs --city <city>');
    process.exit(1);
  }

  dataDir = path.resolve('..', args.city);
  bikepathsPath = path.join(dataDir, 'bikepaths.yml');

  // Read city bounds from config.yml
  const configPath = path.join(dataDir, 'config.yml');
  if (!fs.existsSync(configPath)) {
    console.error(`No config.yml found for city: ${args.city} (looked at ${configPath})`);
    process.exit(1);
  }
  const cityConfig = yaml.load(fs.readFileSync(configPath, 'utf8'));
  if (!cityConfig.bounds) {
    console.error(`No bounds defined in ${configPath}`);
    process.exit(1);
  }
  // Use overpass_bounds if defined (tighter area for querying), otherwise bounds
  const bounds = cityConfig.overpass_bounds || cityConfig.bounds;
  bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;

  // Load city adapter for region-specific queries
  adapter = loadCityAdapter(args.city);
}

// ---------------------------------------------------------------------------
// Step 1: Load manual entries from sidecar file
// ---------------------------------------------------------------------------

function loadManualEntries() {
  const manualPath = path.join(dataDir, 'manual-entries.yml');
  if (!fs.existsSync(manualPath)) return [];
  const data = yaml.load(fs.readFileSync(manualPath, 'utf8'));
  const entries = data?.manual_entries || [];
  if (entries.length > 0) {
    console.log(`  Loaded ${entries.length} manual entries`);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Step 2: Discover cycling relations from OSM
// ---------------------------------------------------------------------------

async function discoverOsmRelations() {
  console.log('Discovering cycling relations from OSM...');
  const q = `[out:json][timeout:120];
(
  relation["route"="bicycle"](${bbox});
  relation["type"="route"]["name"~"${adapter.relationNamePattern}"](${bbox});
);
out tags;`;
  const data = await queryOverpass(q);
  const relations = data.elements.map(el => ({
    id: el.id,
    name: el.tags?.name || `relation-${el.id}`,
    tags: el.tags || {},
  }));
  console.log(`  Found ${relations.length} cycling relations`);
  return relations;
}

// ---------------------------------------------------------------------------
// Step 3: Discover named cycling ways not in relations
// ---------------------------------------------------------------------------

async function discoverOsmNamedWays() {
  console.log('Discovering named cycling ways from OSM...');

  const queries = adapter.namedWayQueries(bbox);

  const allElements = [];
  for (const { label, q } of queries) {
    try {
      const data = await queryOverpass(q);
      console.log(`  ${label}: ${data.elements.length} ways`);
      allElements.push(...data.elements);
    } catch (err) {
      console.error(`  ${label}: failed (${err.message})`);
    }
  }
  const data = { elements: allElements };

  // Group by name — each unique name becomes a potential bike path
  const byName = new Map();
  for (const el of data.elements) {
    const name = el.tags?.name;
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(el);
  }

  // Fetch non-cycling ways that share nodes with discovered cycling ways.
  // Trails in parks connect through hiking-only segments (bicycle:no) that
  // cycling queries miss. Example: Gatineau Park Trail 73 is entirely
  // bicycle:no but connects Trails 54, 74, and 50 at junction nodes.
  // Without Trail 73's geometry, these cycling trails appear isolated.
  //
  // Strategy: get cycling way IDs → find their nodes → find other named
  // ways touching those nodes → add as clustering-only entries.
  const cyclingWayIds = allElements.filter(e => e.id).map(e => e.id);
  const allWaysByName = new Map();
  if (cyclingWayIds.length > 0) {
    // Overpass: find named ways that share nodes with our cycling ways
    const junctionQ = `[out:json][timeout:180];
way(id:${cyclingWayIds.join(',')});
node(w);
way(bn)["name"]["highway"~"path|footway|cycleway"](${bbox});
out geom tags;`;
    try {
      const junctionData = await queryOverpass(junctionQ);
      const cyclingIdSet = new Set(cyclingWayIds);
      for (const el of junctionData.elements) {
        if (el.type !== 'way') continue;
        if (cyclingIdSet.has(el.id)) continue; // already discovered
        const name = el.tags?.name;
        if (!name) continue;
        if (!allWaysByName.has(name)) allWaysByName.set(name, []);
        allWaysByName.get(name).push(el);
      }

      // Add non-bikeable trails as clustering-only entries
      let junctionCount = 0;
      for (const [name, ways] of allWaysByName) {
        if (byName.has(name)) {
          // Already discovered as cycling — merge extra ways for clustering
          continue;
        }
        const anchors = [];
        for (const w of ways) {
          if (w.geometry?.length >= 2) {
            anchors.push([w.geometry[0].lon, w.geometry[0].lat]);
            anchors.push([w.geometry[w.geometry.length - 1].lon, w.geometry[w.geometry.length - 1].lat]);
          }
        }
        if (anchors.length > 0) {
          byName.set(name, ways);
          junctionCount++;
        }
      }
      if (junctionCount > 0) console.log(`  Found ${junctionCount} non-cycling junction trails`);
    } catch (err) {
      console.error(`  Junction ways fetch failed: ${err.message}`);
    }
  }

  // Also build all-ways lookup for entries that already exist (cycling-discovered names)
  // so their _ways include non-cycling segments for junction node connectivity.
  for (const [name, ways] of allWaysByName) {
    if (!byName.has(name)) continue; // already added above
    // Merge junction ways into existing cycling ways for this name
    const existing = allWaysByName.get(name) || [];
    allWaysByName.set(name, [...existing]);
  }

  const namedPaths = [];
  for (const [name, ways] of byName) {
    const anchors = [];
    for (const w of ways) {
      if (w.geometry?.length >= 2) {
        const first = w.geometry[0];
        const last = w.geometry[w.geometry.length - 1];
        anchors.push([first.lon, first.lat]);
        anchors.push([last.lon, last.lat]);
      } else if (w.center) {
        anchors.push([w.center.lon, w.center.lat]);
      }
    }
    if (anchors.length === 0) continue;

    // _ways uses ALL ways with this name (including non-cycling) for junction
    // node connectivity. Combines cycling ways + junction ways (deduplicated by ID).
    const junctionWays = allWaysByName.get(name) || [];
    const seenIds = new Set();
    const combinedWays = [];
    for (const w of [...ways, ...junctionWays]) {
      if (!w.geometry?.length || w.geometry.length < 2) continue;
      if (w.id && seenIds.has(w.id)) continue;
      if (w.id) seenIds.add(w.id);
      combinedWays.push(w.geometry);
    }
    const waysForClustering = combinedWays.length > 0
      ? combinedWays
      : ways.filter(w => w.geometry?.length >= 2).map(w => w.geometry);

    namedPaths.push({
      name,
      wayCount: ways.length,
      tags: mergeWayTags(ways),
      anchors,
      osmNames: [name],
      _ways: waysForClustering,
    });
  }
  console.log(`  Found ${namedPaths.length} named cycling ways`);
  return namedPaths;
}

// ---------------------------------------------------------------------------
// Step 4: Discover unnamed parallel bike lanes
// ---------------------------------------------------------------------------

async function discoverParallelLanes() {
  console.log('Discovering unnamed parallel bike lanes...');

  const filter = adapter.parallelLaneFilter || defaultParallelLaneFilter;

  // Query all unnamed cycleways, excluding crossings
  const q = `[out:json][timeout:120];
way["highway"="cycleway"][!"name"][!"crossing"](${bbox});
out tags center;`;

  const data = await queryOverpass(q);
  const candidates = data.elements.filter(el => filter(el.tags || {}));
  console.log(`  ${data.elements.length} unnamed cycleways, ${candidates.length} after filter`);

  if (candidates.length === 0) return [];

  // Chain nearby segments
  const segments = candidates.map(el => ({
    id: el.id,
    center: el.center,
    tags: el.tags || {},
  }));
  const chains = chainSegments(segments, 50);
  console.log(`  Chained into ${chains.length} groups`);

  // Find nearest named road for each chain
  const results = [];
  for (const chain of chains) {
    const { lat, lon } = chain.midpoint;
    const roadQ = `[out:json][timeout:15];
way["highway"~"^(primary|secondary|tertiary|residential|unclassified)$"]["name"]
  (around:30,${lat},${lon});
out tags center;`;

    try {
      const roadData = await queryOverpass(roadQ);
      if (roadData.elements.length === 0) continue;
      const best = selectBestRoad(roadData.elements, { lat, lon });
      if (!best) continue;
      const roadName = best.name;

      results.push({
        roadName,
        chain,
        tags: mergeWayTags(chain.tags.map((t, i) => ({ tags: t, id: chain.segmentIds[i] }))),
      });
    } catch (err) {
      console.log(`  Road lookup failed for chain at ${lat},${lon}: ${err.message}`);
    }
  }

  console.log(`  Matched ${results.length} chains to named roads`);

  // Group by road name + spatial proximity
  const grouped = groupByRoadAndProximity(results, 500);
  console.log(`  Grouped into ${grouped.length} parallel lane candidates`);

  return grouped;
}

/**
 * Group chains with the same road name only if their bboxes are within proximityM of each other.
 * Same road name far apart = separate entries.
 */
function groupByRoadAndProximity(results, proximityM) {
  const groups = [];

  for (const r of results) {
    let merged = false;
    for (const g of groups) {
      if (g.roadName !== r.roadName) continue;
      if (bboxDistance(g.bbox, r.chain.bbox) <= proximityM) {
        g.chains.push(r.chain);
        g.allTags.push(...r.chain.tags);
        g.bbox = mergeBboxes(g.bbox, r.chain.bbox);
        merged = true;
        break;
      }
    }
    if (!merged) {
      groups.push({
        roadName: r.roadName,
        chains: [r.chain],
        allTags: [...r.chain.tags],
        bbox: { ...r.chain.bbox },
      });
    }
  }

  return groups.map(g => ({
    name: g.roadName,
    parallel_to: g.roadName,
    anchors: [
      [g.bbox.west, g.bbox.south],
      [g.bbox.east, g.bbox.north],
    ],
    tags: mergeWayTags(g.allTags.map((t, i) => ({ tags: t, id: i }))),
    _chainCoords: g.chains.flatMap(c =>
      c.tags.map((_, i) => [c.midpoint.lat, c.midpoint.lon])
    ),
  }));
}

function bboxDistance(a, b) {
  if (a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west) return 0;
  const latA = (a.south + a.north) / 2;
  const lngA = (a.west + a.east) / 2;
  const latB = (b.south + b.north) / 2;
  const lngB = (b.west + b.east) / 2;
  return haversineM([lngA, latA], [lngB, latB]);
}

function mergeBboxes(a, b) {
  return {
    south: Math.min(a.south, b.south),
    north: Math.max(a.north, b.north),
    west: Math.min(a.west, b.west),
    east: Math.max(a.east, b.east),
  };
}

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Extract useful OSM tags into structured metadata for bikepaths.yml.
 * Only includes fields that have values — no nulls or empty strings.
 */
function extractOsmMetadata(tags) {
  if (!tags) return {};
  const meta = {};

  // Bilingual names
  if (tags['name:fr']) meta.name_fr = tags['name:fr'];
  if (tags['name:en']) meta.name_en = tags['name:en'];
  if (tags.alt_name) meta.alt_name = tags.alt_name;

  // External references
  if (tags.wikipedia) meta.wikipedia = tags.wikipedia;
  if (tags.wikidata) meta.wikidata = tags.wikidata;
  if (tags.wikimedia_commons) meta.wikimedia_commons = tags.wikimedia_commons;
  if (tags.website || tags['contact:website']) meta.website = tags.website || tags['contact:website'];

  // Physical characteristics
  if (tags.surface) meta.surface = tags.surface;
  if (tags.smoothness) meta.smoothness = tags.smoothness;
  if (tags.width) meta.width = tags.width;
  if (tags.lit) meta.lit = tags.lit;
  if (tags.incline) meta.incline = tags.incline;

  // Cycling infrastructure type
  if (tags.segregated) meta.segregated = tags.segregated;
  if (tags.cycleway) meta.cycleway = tags.cycleway;
  if (tags.highway) meta.highway = tags.highway;
  if (tags.tracktype) meta.tracktype = tags.tracktype;
  if (tags['mtb:scale'] != null) meta['mtb:scale'] = tags['mtb:scale'];
  if (tags['mtb:scale:imba'] != null) meta['mtb:scale:imba'] = tags['mtb:scale:imba'];
  if (tags.bicycle) meta.bicycle = tags.bicycle;

  // Network and management
  if (tags.operator) meta.operator = tags.operator;
  if (tags.network) meta.network = tags.network;
  if (tags.ref) meta.ref = tags.ref;
  if (tags.cycle_network) meta.cycle_network = tags.cycle_network;

  // Route info (relations)
  if (tags.distance) meta.distance = tags.distance;
  if (tags.description) meta.description = tags.description;

  // Seasonal / access
  if (tags.opening_hours) meta.opening_hours = tags.opening_hours;
  if (tags.seasonal) meta.seasonal = tags.seasonal;
  if (tags.access) meta.access = tags.access;

  return meta;
}

/**
 * For named ways grouped by name, pick the most common value for each tag
 * across all ways in the group.
 */
function mergeWayTags(ways) {
  const tagCounts = {};
  for (const way of ways) {
    const tags = way.tags || {};
    for (const [key, val] of Object.entries(tags)) {
      if (!tagCounts[key]) tagCounts[key] = {};
      tagCounts[key][val] = (tagCounts[key][val] || 0) + 1;
    }
  }
  // Pick the most common value for each tag
  const merged = {};
  for (const [key, vals] of Object.entries(tagCounts)) {
    let bestVal = null, bestCount = 0;
    for (const [val, count] of Object.entries(vals)) {
      if (count > bestCount) { bestCount = count; bestVal = val; }
    }
    merged[key] = bestVal;
  }
  return merged;
}

/**
 * Enrich an entry with OSM metadata, only adding fields it doesn't
 * already have (hand-edited values take precedence).
 */
function enrichEntry(entry, tags) {
  const meta = extractOsmMetadata(tags);
  for (const [key, val] of Object.entries(meta)) {
    if (entry[key] == null) entry[key] = val;
  }
}

// ---------------------------------------------------------------------------
/**
 * Split ways with the same name into connected components.
 * "Trail 20" in the Greenbelt and "Trail 20" in Gatineau Park are
 * different trails — they share a name but have no geometric connection.
 * OVRT is one 30km trail — its ways chain continuously via shared nodes.
 *
 * Uses real geometry: shared OSM nodes first, then endpoint proximity
 * (100m tolerance) as a fallback for mapping gaps. Never midpoints.
 */
const ENDPOINT_SNAP_M = 100;

function splitWaysByConnectivity(ways) {
  if (ways.length <= 1) return [ways];

  // Union-find
  const parent = ways.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  // Phase 1: merge ways that share an OSM node
  const nodeToWay = new Map();
  for (let i = 0; i < ways.length; i++) {
    for (const nodeId of ways[i].nodes || []) {
      if (nodeToWay.has(nodeId)) {
        union(i, nodeToWay.get(nodeId));
      } else {
        nodeToWay.set(nodeId, i);
      }
    }
  }

  // Phase 2: merge ways whose endpoints are within ENDPOINT_SNAP_M
  // Uses real endpoint coordinates from geometry, not midpoints.
  const endpoints = ways.map(w => {
    if (!w.geometry?.length) return null;
    const g = w.geometry;
    return [
      { lat: g[0].lat, lon: g[0].lon },
      { lat: g[g.length - 1].lat, lon: g[g.length - 1].lon },
    ];
  });

  for (let i = 0; i < ways.length; i++) {
    if (!endpoints[i]) continue;
    for (let j = i + 1; j < ways.length; j++) {
      if (!endpoints[j]) continue;
      if (find(i) === find(j)) continue;
      // Check all 4 endpoint pairs
      for (const a of endpoints[i]) {
        for (const b of endpoints[j]) {
          const dlat = (a.lat - b.lat) * 111320;
          const dlng = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
          if (dlat * dlat + dlng * dlng < ENDPOINT_SNAP_M * ENDPOINT_SNAP_M) {
            union(i, j);
          }
        }
      }
    }
  }

  // Phase 3: merge components whose real geometry bounding boxes are
  // within 2km. Catches road bike lanes with intersection gaps — the
  // segments are disconnected but clearly the same road facility.
  // Uses bbox edges (real geometry extent), not midpoints or centers.
  const BBOX_MERGE_M = 2000;
  const bboxOf = (indices) => {
    let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
    for (const i of indices) {
      for (const pt of ways[i].geometry || []) {
        if (pt.lat < s) s = pt.lat;
        if (pt.lat > n) n = pt.lat;
        if (pt.lon < w) w = pt.lon;
        if (pt.lon > e) e = pt.lon;
      }
    }
    return { s, n, w, e };
  };
  const components = new Map();
  for (let i = 0; i < ways.length; i++) {
    const root = find(i);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(i);
  }
  const roots = [...components.keys()];
  const bboxes = new Map(roots.map(r => [r, bboxOf(components.get(r))]));
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      if (find(roots[i]) === find(roots[j])) continue;
      const a = bboxes.get(roots[i]), b = bboxes.get(roots[j]);
      // Min distance between bbox edges (not centers)
      const latGap = Math.max(0, Math.max(a.s, b.s) - Math.min(a.n, b.n)) * 111320;
      const lonGap = Math.max(0, Math.max(a.w, b.w) - Math.min(a.e, b.e)) * 111320 *
        Math.cos(((a.s + a.n) / 2) * Math.PI / 180);
      if (Math.sqrt(latGap * latGap + lonGap * lonGap) < BBOX_MERGE_M) {
        union(roots[i], roots[j]);
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < ways.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(ways[i]);
  }
  return [...groups.values()];
}

// Step 5: Build entries from scratch (replaces mergeData)
// ---------------------------------------------------------------------------

/**
 * Build entries from discovered OSM data and manual entries.
 * No reference to any existing bikepaths.yml — built from scratch.
 */
function buildEntries(osmRelations, osmNamedWays, parallelLanes, manualEntries) {
  console.log('Building entries from scratch...');

  const bySlug = new Map();
  const byRelation = new Map();
  const byName = new Map();
  const result = [];

  // Add manual entries first
  for (const entry of manualEntries) {
    const slug = slugify(entry.name);
    bySlug.set(slug, entry);
    byName.set(entry.name.toLowerCase(), entry);
    result.push(entry);
    if (entry.osm_relations) {
      for (const relId of entry.osm_relations) byRelation.set(relId, entry);
    }
  }

  // Add OSM relations
  for (const rel of osmRelations) {
    if (byRelation.has(rel.id)) {
      enrichEntry(byRelation.get(rel.id), rel.tags);
      continue;
    }
    const slug = slugify(rel.name);
    if (bySlug.has(slug)) {
      const entry = bySlug.get(slug);
      if (!entry.osm_relations) entry.osm_relations = [];
      entry.osm_relations.push(rel.id);
      enrichEntry(entry, rel.tags);
      byRelation.set(rel.id, entry);
      continue;
    }

    const meta = extractOsmMetadata(rel.tags);
    const entry = {
      name: rel.name,
      osm_relations: [rel.id],
      ...meta,
    };
    result.push(entry);
    bySlug.set(slug, entry);
    byRelation.set(rel.id, entry);
    byName.set(rel.name.toLowerCase(), entry);
  }

  // Add named ways
  for (const np of osmNamedWays) {
    const slug = slugify(np.name);
    const existing = bySlug.get(slug) || byName.get(np.name.toLowerCase());
    if (existing) {
      // Don't merge entries that are far apart — they're different trails
      // with the same slug. E.g., "Trail 24" (Greenbelt, 45.30°N) and
      // "Trail #24" (Gatineau Park, 45.52°N) both slug to trail-24.
      // EXCEPTION: always merge into a relation entry with the same name.
      // Relations are authoritative — a trail with a gap in the middle
      // (Voie Verte Chelsea) should still be one entry.
      const hasRelation = existing.osm_relations?.length > 0;
      const tooFar = !hasRelation &&
        existing.anchors?.length > 0 && np.anchors?.length > 0 &&
        haversineM(existing.anchors[0], np.anchors[0]) > 5000;
      if (tooFar) {
        // Different trail, same slug — create separate entry (slug will be disambiguated later)
        const meta = extractOsmMetadata(np.tags);
        const entry = { name: np.name, osm_names: np.osmNames, anchors: np.anchors, _ways: np._ways, ...meta };
        result.push(entry);
        continue;
      }
      enrichEntry(existing, np.tags);
      if (np.anchors?.length > (existing.anchors?.length || 0)) existing.anchors = np.anchors;
      if (np._ways) existing._ways = np._ways;
      if (!existing.osm_names) {
        existing.osm_names = np.osmNames;
      }
      continue;
    }

    const meta = extractOsmMetadata(np.tags);
    const entry = {
      name: np.name,
      osm_names: np.osmNames,
      anchors: np.anchors,
      _ways: np._ways,
      ...meta,
    };
    result.push(entry);
    bySlug.set(slug, entry);
    byName.set(np.name.toLowerCase(), entry);
  }

  // Add parallel lanes
  let parallelAdded = 0;
  let parallelMerged = 0;
  for (const candidate of parallelLanes) {
    const slug = slugify(candidate.name);
    const existingEntry = bySlug.get(slug) || byName.get(candidate.name.toLowerCase());
    if (existingEntry) {
      if (!existingEntry.parallel_to) {
        existingEntry.parallel_to = candidate.parallel_to;
        parallelMerged++;
        console.log(`  ~ merged parallel geometry into: ${existingEntry.name}`);
      }
      continue;
    }

    const entry = {
      name: candidate.name,
      parallel_to: candidate.parallel_to,
      highway: candidate.tags.highway || 'cycleway',
      anchors: candidate.anchors,
    };
    for (const key of ['surface', 'lit', 'width', 'smoothness']) {
      if (candidate.tags[key]) entry[key] = candidate.tags[key];
    }
    result.push(entry);
    bySlug.set(slug, entry);
    byName.set(candidate.name.toLowerCase(), entry);
    parallelAdded++;
    console.log(`  + parallel lane: ${candidate.name}`);
  }

  if (parallelAdded > 0 || parallelMerged > 0) {
    console.log(`  Parallel lanes added: ${parallelAdded}, merged into existing: ${parallelMerged}`);
  }

  console.log(`  Built ${result.length} entries from scratch`);
  return result;
}

// ---------------------------------------------------------------------------
// Enrich out-of-bounds relations
// ---------------------------------------------------------------------------

/**
 * Enrich manually added entries whose osm_relations were not found by the
 * bbox-scoped discovery query. Fetches tags directly by relation ID.
 * This is what makes manual one-offs work: add a relation ID to the file,
 * and the next script run fills in name, surface, network, etc. from OSM.
 */
async function enrichOutOfBoundsRelations(entries, discoveredRelationIds) {
  const missing = [];
  for (const entry of entries) {
    for (const relId of entry.osm_relations ?? []) {
      if (!discoveredRelationIds.has(relId)) {
        missing.push({ relId, entry });
      }
    }
  }
  if (missing.length === 0) return;

  console.log(`Enriching ${missing.length} out-of-bounds relations...`);
  const relIds = missing.map(m => m.relId);
  const q = `[out:json][timeout:60];\n(\n${relIds.map(id => `  relation(${id});`).join('\n')}\n);\nout tags;`;
  try {
    const data = await queryOverpass(q);
    const byId = new Map(data.elements.map(el => [el.id, el.tags || {}]));
    for (const { relId, entry } of missing) {
      const tags = byId.get(relId);
      if (tags) {
        enrichEntry(entry, tags);
        console.log(`  Enriched: ${entry.name} (relation ${relId})`);
      }
    }
  } catch (err) {
    console.error(`  Failed to enrich out-of-bounds relations: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Resolve network members
// ---------------------------------------------------------------------------

// Apply OSM superroute data as super_network attributes on entries.
// Super-networks (Capital Pathway, TCT) are NOT pages — they're metadata
// that shows in the facts table and influences index grouping.
// The real networks come from auto-grouping (type: network).
// Turn OSM superroutes into real type: network entries.
// Members that are already in an auto-group network stay there —
// the auto-group network gets a super_network attribute for index grouping.
// Only orphaned paths (not in any network) become direct members.
function addSuperrouteNetworks(entries, networks) {
  const byRelation = new Map();
  for (const entry of entries) {
    for (const relId of entry.osm_relations ?? []) {
      byRelation.set(relId, entry);
    }
  }

  // Snapshot: entries in park-based networks should not be reassigned.
  // Park containment is the strongest signal. Auto-group networks CAN be
  // flattened into superroute networks.
  const parkNetworks = new Set();
  for (const entry of entries) {
    if (entry.type === 'network' && entry._parkName) parkNetworks.add(entry);
  }
  const parkMembers = new Set();
  for (const entry of entries) {
    if (entry._networkRef && parkNetworks.has(entry._networkRef)) {
      parkMembers.add(entry);
    }
  }

  const superNetworkMeta = [];

  // Sort networks least-specific-first so the most specific (local)
  // network processes last and wins super_network assignment.
  // ncn (national) < rcn (regional) < lcn (local) < unknown.
  // Capital Pathway (rcn) should beat Trans Canada Trail (ncn).
  const NET_PRIORITY = { ncn: 0, rcn: 1, lcn: 2 };
  const sortedNetworks = [...networks]
    .filter(n => !n._promoted)
    .sort((a, b) => {
      const pa = NET_PRIORITY[a.network] ?? 3;
      const pb = NET_PRIORITY[b.network] ?? 3;
      return pa - pb;
    });

  for (const network of sortedNetworks) {
    const name = network.name;

    // Create network entry shell — _memberRefs populated below
    const networkEntry = {
      name,
      type: 'network',
      _memberRefs: [],
      osm_relations: network.osm_relations,
    };
    if (network.name_fr) networkEntry.name_fr = network.name_fr;
    if (network.name_en) networkEntry.name_en = network.name_en;
    if (network.operator) networkEntry.operator = network.operator;
    if (network.network) networkEntry.network = network.network;
    if (network.wikidata) networkEntry.wikidata = network.wikidata;
    if (network.wikipedia) networkEntry.wikipedia = network.wikipedia;
    if (network.cycle_network) networkEntry.cycle_network = network.cycle_network;

    // Resolve members: assign paths to this network.
    // A path can belong to multiple networks (e.g. Watts Creek is in both
    // NCC Greenbelt and Capital Pathway). member_of (from _networkRef) is
    // the PRIMARY network (determines URL). But the path also appears in
    // secondary networks' members arrays for display on those pages.
    // If a relation maps to a type: network entry (e.g. Rideau Canal Western
    // became an auto-group), flatten through its non-network members.
    // Also tag existing networks with _superNetworkRef for index grouping.
    for (const relId of network._member_relations || []) {
      const member = byRelation.get(relId);
      if (!member) continue;

      if (member.type === 'network') {
        // Park networks are NOT intermediaries — don't flatten them.
        // Their members stay primary to the park. Just add them as
        // secondary members of this superroute network.
        if (parkNetworks.has(member)) {
          member._superNetworkRef = networkEntry;
          for (const sub of (member._memberRefs || [])) {
            if (sub.type === 'network') continue;
            if (!networkEntry._memberRefs.includes(sub)) {
              networkEntry._memberRefs.push(sub);
            }
          }
          continue;
        }
        // Flatten: adopt its _memberRefs into this superroute network.
        // Only auto-group networks get flattened — they're intermediaries.
        // byRelation was built at function start, so networks created by
        // earlier iterations of THIS loop won't be in it. Cross-call
        // flattening is prevented by combining all networks into one call.
        for (const sub of [...(member._memberRefs || [])]) {
          if (sub.type === 'network') continue;
          if (sub._networkRef === member || !sub._networkRef) {
            networkEntry._memberRefs.push(sub);
            sub._networkRef = networkEntry;
            if (member._memberRefs) {
              member._memberRefs = member._memberRefs.filter(m => m !== sub);
            }
          } else if (!networkEntry._memberRefs.includes(sub)) {
            // Already in another network — add as secondary member
            // (appears in members array, but member_of stays as-is)
            networkEntry._memberRefs.push(sub);
          }
        }
        // Tag the sub-network with _superNetworkRef (most specific wins —
        // networks are sorted largest-first so smaller overwrites larger)
        member._superNetworkRef = networkEntry;
        continue;
      }

      if (member._networkRef) {
        // Already in a network (auto-group or park) — add as secondary
        // member and tag with _superNetworkRef for index grouping.
        member._networkRef._superNetworkRef = networkEntry;
        member._superNetworkRef = networkEntry;
        if (!networkEntry._memberRefs.includes(member)) {
          networkEntry._memberRefs.push(member);
        }
        continue;
      }

      // Park members keep their primary network but join this one too
      if (parkMembers.has(member)) {
        member._superNetworkRef = networkEntry;
        if (!networkEntry._memberRefs.includes(member)) {
          networkEntry._memberRefs.push(member);
        }
        continue;
      }
      networkEntry._memberRefs.push(member);
      member._networkRef = networkEntry;
    }

    // Fallback: adopt orphaned paths with matching operator.
    // Catches paths like Pinecrest Creek (NCC, cycleway) that aren't in
    // the OSM superroute member list but clearly belong to the system.
    if (network.operator) {
      for (const entry of entries) {
        if (entry._networkRef || entry.type === 'network') continue;
        // Operator must match (handles NCC variants)
        const op = entry.operator || '';
        const netOp = network.operator || '';
        if (!op || (!op.includes(netOp) && !netOp.includes(op))) continue;
        // Must be cycling infrastructure
        if (entry.highway !== 'cycleway' && entry.highway !== 'path') continue;
        if (!networkEntry._memberRefs.includes(entry)) {
          networkEntry._memberRefs.push(entry);
          entry._networkRef = networkEntry;
        }
      }
    }

    // Ref matching: orphaned entries sharing a `ref` tag with existing members
    // belong to the same route system. E.g., ref: GPW ties Greenbelt Pathway
    // West (Barrhaven) to the Greenbelt network. More specific than operator.
    const refTags = new Set();
    for (const memberEntry of networkEntry._memberRefs) {
      if (memberEntry.ref) refTags.add(memberEntry.ref);
    }
    if (refTags.size > 0) {
      for (const entry of entries) {
        if (entry._networkRef || entry.type === 'network') continue;
        if (parkMembers.has(entry)) continue;
        if (!entry.ref || !refTags.has(entry.ref)) continue;
        // Exclude roads — they have ref tags (route numbers) that would
        // cause false matches. Allow entries without highway (relation-only).
        const roadHw = ['primary', 'secondary', 'tertiary', 'residential', 'unclassified'];
        if (entry.highway && roadHw.includes(entry.highway)) continue;
        if (!networkEntry._memberRefs.includes(entry)) {
          networkEntry._memberRefs.push(entry);
          entry._networkRef = networkEntry;
          console.log(`    ref match: ${entry.name} (ref: ${entry.ref}) → ${name}`);
        }
      }
    }

    if (networkEntry._memberRefs.length === 0) {
      console.log(`  Skipping superroute network "${name}": no orphaned members`);
      continue;
    }

    entries.push(networkEntry);
    console.log(`  Superroute network: ${name} (${networkEntry._memberRefs.length} members)`);

    // Store metadata for YAML output (slug resolved in final pass)
    const meta = { name, _entryRef: networkEntry };
    if (network.wikidata) meta.wikidata = network.wikidata;
    if (network.operator) meta.operator = network.operator;
    if (network.name_fr) meta.name_fr = network.name_fr;
    if (network.wikidata_meta) meta.wikidata_meta = network.wikidata_meta;
    superNetworkMeta.push(meta);
  }

  return superNetworkMeta;
}

// ---------------------------------------------------------------------------
// Helper: load markdown slugs
// ---------------------------------------------------------------------------

function loadMarkdownSlugs() {
  const bikePathsDir = path.join(dataDir, 'bike-paths');
  const slugs = new Set();
  if (fs.existsSync(bikePathsDir)) {
    for (const f of fs.readdirSync(bikePathsDir)) {
      if (!f.endsWith('.md') || f.includes('.fr.')) continue;
      slugs.add(f.replace(/\.md$/, ''));
      // Parse includes from frontmatter — claims those slugs too
      try {
        const content = fs.readFileSync(path.join(bikePathsDir, f), 'utf8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const includes = fmMatch[1].match(/includes:\n((?:\s+-\s+.+\n?)*)/);
          if (includes) {
            for (const line of includes[1].split('\n')) {
              const slug = line.replace(/^\s+-\s+/, '').trim();
              if (slug) slugs.add(slug);
            }
          }
        }
      } catch {}
    }
  }
  return slugs;
}

/**
 * Parse markdown frontmatter overrides into a structured map.
 * Currently supports: member_of.
 */
// Fields that markdown frontmatter can override on bikepaths.yml entries.
// member_of has special handling (network reassignment). Everything else
// is a simple field overwrite — if a human puts it in markdown, it wins.
const MARKDOWN_OVERRIDE_FIELDS = [
  'member_of', 'operator', 'path_type',
];

export function parseMarkdownOverrides(bikePathsDir) {
  const overrides = new Map();
  if (!bikePathsDir || !fs.existsSync(bikePathsDir)) return overrides;
  for (const f of fs.readdirSync(bikePathsDir).filter(f => f.endsWith('.md') && !f.includes('.fr.'))) {
    const content = fs.readFileSync(path.join(bikePathsDir, f), 'utf8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    let fm;
    try { fm = yaml.load(fmMatch[1]); } catch { continue; }
    const mdSlug = f.replace('.md', '');
    const override = {};
    for (const field of MARKDOWN_OVERRIDE_FIELDS) {
      if (fm?.[field] != null) override[field] = fm[field];
    }
    if (Object.keys(override).length > 0) overrides.set(mdSlug, override);
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The pipeline. One function, one code path. main() calls it with the real
// Overpass client. Tests call it with a cassette player.
// ---------------------------------------------------------------------------

/**
 * Run the full bikepaths pipeline. No file I/O — returns entries + metadata.
 *
 * @param {object} opts
 * @param {Function} opts.queryOverpass — async (q) => { elements: [] }
 * @param {string} opts.bbox — "south,west,north,east"
 * @param {object} opts.adapter — city adapter (from city-adapter.mjs)
 * @param {Array} [opts.manualEntries] — out-of-bounds manual entries
 * @param {Set<string>} [opts.markdownSlugs] — slugs claimed by markdown
 * @param {Map<string, {member_of?: string}>} [opts.markdownOverrides] — frontmatter overrides by slug
 * @returns {Promise<{ entries: Array, superNetworks: Array, slugMap: Map }>}
 */
export async function buildBikepathsPipeline({ queryOverpass: qo, bbox: b, adapter: a, manualEntries = [], markdownSlugs = new Set(), markdownOverrides = new Map() }) {
  // Step 1: Discover cycling relations
  console.log('Discovering cycling relations from OSM...');
  const relQ = `[out:json][timeout:120];
(
  relation["route"="bicycle"](${b});
  relation["type"="route"]["name"~"${a.relationNamePattern}"](${b});
);
out tags;`;
  const relData = await qo(relQ);
  const osmRelations = relData.elements.map(el => ({
    id: el.id,
    name: el.tags?.name || `relation-${el.id}`,
    tags: el.tags || {},
  }));
  console.log(`  Found ${osmRelations.length} cycling relations`);

  // Step 1b: Resolve relation base names for ghost entry removal in step 8c.
  // Named ways sometimes duplicate relation entries (e.g. "Ottawa River Pathway"
  // ways create ghost entries alongside "Ottawa River Pathway (east)" relations).
  // We collect the base names here and remove the ghosts after the full pipeline.
  const relationBaseNames = new Set(osmRelations.map(r =>
    r.name.replace(/\s*\(.*?\)\s*$/, '').toLowerCase()
  ));

  // Step 2: Discover named cycling ways (with junction trail expansion)
  console.log('Discovering named cycling ways from OSM...');
  const namedWayQueries = a.namedWayQueries(b);
  const allWayElements = [];
  for (const { label, q } of namedWayQueries) {
    try {
      const data = await qo(q);
      console.log(`  ${label}: ${data.elements.length} ways`);
      allWayElements.push(...data.elements);
    } catch (err) {
      console.error(`  ${label}: failed (${err.message})`);
    }
  }

  const waysByName = new Map();
  for (const el of allWayElements) {
    const name = el.tags?.name;
    if (!name) continue;
    if (!waysByName.has(name)) waysByName.set(name, []);
    waysByName.get(name).push(el);
  }

  // Fetch non-cycling junction ways that share nodes with cycling ways.
  // Trails in parks connect through hiking-only segments (bicycle:no).
  const cyclingWayIds = allWayElements.filter(e => e.id).map(e => e.id);
  const allWaysByName = new Map();
  if (cyclingWayIds.length > 0) {
    const junctionQ = `[out:json][timeout:180];
way(id:${cyclingWayIds.join(',')});
node(w);
way(bn)["name"]["highway"~"path|footway|cycleway"](${b});
out geom tags;`;
    try {
      const junctionData = await qo(junctionQ);
      const cyclingIdSet = new Set(cyclingWayIds);
      for (const el of junctionData.elements) {
        if (el.type !== 'way') continue;
        if (cyclingIdSet.has(el.id)) continue;
        const name = el.tags?.name;
        if (!name) continue;
        if (!allWaysByName.has(name)) allWaysByName.set(name, []);
        allWaysByName.get(name).push(el);
      }

      let junctionCount = 0;
      for (const [name, ways] of allWaysByName) {
        if (waysByName.has(name)) continue;
        const anchors = [];
        for (const w of ways) {
          if (w.geometry?.length >= 2) {
            anchors.push([w.geometry[0].lon, w.geometry[0].lat]);
            anchors.push([w.geometry[w.geometry.length - 1].lon, w.geometry[w.geometry.length - 1].lat]);
          }
        }
        if (anchors.length > 0) {
          waysByName.set(name, ways);
          junctionCount++;
        }
      }
      if (junctionCount > 0) console.log(`  Found ${junctionCount} non-cycling junction trails`);
    } catch (err) {
      console.error(`  Junction ways fetch failed: ${err.message}`);
    }
  }

  // Build named way entries. Split same-named ways that are geographically
  // far apart — "Trail 20" in the Greenbelt (45.32°N) and "Trail 20" in
  // Gatineau Park (45.52°N) are different trails that happen to share a name.
  const osmNamedWays = [];
  for (const [name, ways] of waysByName) {
    // Split same-named ways into connected components using real geometry.
    // Shared OSM nodes + 100m endpoint snap. OVRT (one continuous trail)
    // stays one entry. Trail 20 in different parks stays separate.
    const wayClusters = splitWaysByConnectivity(ways);

    for (const clusterWays of wayClusters) {
      const anchors = [];
      for (const w of clusterWays) {
        if (w.geometry?.length >= 2) {
          anchors.push([w.geometry[0].lon, w.geometry[0].lat]);
          anchors.push([w.geometry[w.geometry.length - 1].lon, w.geometry[w.geometry.length - 1].lat]);
        } else if (w.center) {
          anchors.push([w.center.lon, w.center.lat]);
        }
      }
      if (anchors.length === 0) continue;

      // Include junction ways that share nodes or have endpoints near
      // THIS cluster's ways (not all junction ways with the same name).
      const clusterNodeIds = new Set(clusterWays.flatMap(w => w.nodes || []));
      const junctionWays = (allWaysByName.get(name) || []).filter(jw => {
        // Shared nodes
        if (jw.nodes?.some(n => clusterNodeIds.has(n))) return true;
        // Endpoint proximity (100m)
        if (!jw.geometry?.length) return false;
        const jwEps = [jw.geometry[0], jw.geometry[jw.geometry.length - 1]];
        for (const cw of clusterWays) {
          if (!cw.geometry?.length) continue;
          const cwEps = [cw.geometry[0], cw.geometry[cw.geometry.length - 1]];
          for (const a of jwEps) {
            for (const b of cwEps) {
              const dlat = (a.lat - b.lat) * 111320;
              const dlng = (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180);
              if (dlat * dlat + dlng * dlng < 10000) return true; // 100m
            }
          }
        }
        return false;
      });

      const seenIds = new Set();
      const combinedWays = [];
      for (const w of [...clusterWays, ...junctionWays]) {
        if (!w.geometry?.length || w.geometry.length < 2) continue;
        if (w.id && seenIds.has(w.id)) continue;
        if (w.id) seenIds.add(w.id);
        combinedWays.push(w.geometry);
      }

      osmNamedWays.push({
        name,
        wayCount: clusterWays.length,
        tags: mergeWayTags(clusterWays),
        anchors,
        osmNames: [name],
        _ways: combinedWays.length > 0 ? combinedWays : clusterWays.filter(w => w.geometry?.length >= 2).map(w => w.geometry),
      });
    }
  }
  // Token-based name similarity for fragment merging.
  // Tokenize, hard-reject on numeric mismatch, soft Dice with edit-distance-1 tolerance.
  function namesAreSimilar(a, b) {
    const tokenize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/\(.*?\)/g, '').match(/[a-z0-9]+/g) || [];
    const editDist1 = (s, t) => {
      if (Math.abs(s.length - t.length) > 1) return false;
      let diffs = 0;
      if (s.length === t.length) {
        for (let i = 0; i < s.length; i++) { if (s[i] !== t[i]) diffs++; }
        return diffs === 1;
      }
      // length differs by 1 — check for single insertion
      const [short, long] = s.length < t.length ? [s, t] : [t, s];
      let si = 0;
      for (let li = 0; li < long.length; li++) {
        if (short[si] === long[li]) si++;
        else diffs++;
        if (diffs > 1) return false;
      }
      return true;
    };

    const tokA = tokenize(a), tokB = tokenize(b);
    if (tokA.length < 2 || tokB.length < 2) return false;

    // Hard reject: if any numeric token in A has no match in B
    const numA = tokA.filter(t => /^\d+$/.test(t));
    const numB = tokB.filter(t => /^\d+$/.test(t));
    if (numA.length > 0 || numB.length > 0) {
      if (numA.sort().join(',') !== numB.sort().join(',')) return false;
    }

    // Soft Dice: tokens match if identical or (both >= 4 chars and edit distance 1)
    const usedB = new Set();
    let matched = 0;
    for (const ta of tokA) {
      for (let j = 0; j < tokB.length; j++) {
        if (usedB.has(j)) continue;
        const tb = tokB[j];
        if (ta === tb || (ta.length >= 4 && tb.length >= 4 && editDist1(ta, tb))) {
          matched++;
          usedB.add(j);
          break;
        }
      }
    }
    const dice = (2 * matched) / (tokA.length + tokB.length);
    return dice >= 0.85 && matched >= 2;
  }

  // Merge small fragments into nearby larger entries with similar names.
  // "Voie Verte de Chelsea" (0.2km) is a typo variant of "Voie Verte Chelsea"
  // (22km). Relative to the trail length, the fragment is insignificant.
  // Absorb it: merge its _ways into the larger entry and drop it.
  const absorbed = new Set();
  for (let i = 0; i < osmNamedWays.length; i++) {
    const small = osmNamedWays[i];
    if (absorbed.has(i)) continue;
    for (let j = 0; j < osmNamedWays.length; j++) {
      if (i === j || absorbed.has(j)) continue;
      const large = osmNamedWays[j];
      if (large.wayCount <= small.wayCount) continue; // large must be bigger

      // Skip exact same name — splitWaysByConnectivity already decided
      // these are different trails in different parks.
      if (small.name === large.name) continue;
      if (slugify(small.name) === slugify(large.name)) continue;

      // Token-based soft Dice similarity (Codex recommendation).
      // Language-agnostic, handles typos (vert/verte), particles (de/du),
      // parentheticals. Hard rejects numeric token mismatches (Trail 22 ≠ Trail 24).
      if (!namesAreSimilar(small.name, large.name)) continue;

      // Geographically close?
      if (!small.anchors?.length || !large.anchors?.length) continue;
      if (haversineM(small.anchors[0], large.anchors[0]) > 10000) continue;

      // Small relative to large? (< 20% way count)
      if (small.wayCount > large.wayCount * 0.2) continue;

      // Absorb: merge small's _ways into large, drop small
      large._ways = [...(large._ways || []), ...(small._ways || [])];
      large.anchors = [...large.anchors, ...small.anchors];
      absorbed.add(i);
      break;
    }
  }
  if (absorbed.size > 0) {
    const before = osmNamedWays.length;
    for (const idx of [...absorbed].sort((a, b) => b - a)) {
      osmNamedWays.splice(idx, 1);
    }
    console.log(`  Merged ${absorbed.size} small fragments into larger entries (${before} → ${osmNamedWays.length})`);
  }

  console.log(`  Found ${osmNamedWays.length} named cycling ways`);

  // Step 2b: Discover unnamed parallel bike lanes
  console.log('Discovering unnamed parallel bike lanes...');
  const filter = (a.parallelLaneFilter || defaultParallelLaneFilter);
  const plQ = `[out:json][timeout:120];
way["highway"="cycleway"][!"name"][!"crossing"](${b});
out tags center;`;
  const plData = await qo(plQ);
  const plCandidates = plData.elements.filter(el => filter(el.tags || {}));
  let parallelLanes = [];
  if (plCandidates.length > 0) {
    const segments = plCandidates.map(el => ({ id: el.id, center: el.center, tags: el.tags || {} }));
    const chains = chainSegments(segments, 50);
    const results = [];
    for (const chain of chains) {
      const { lat, lon } = chain.midpoint;
      const roadQ = `[out:json][timeout:15];
way["highway"~"^(primary|secondary|tertiary|residential|unclassified)$"]["name"]
  (around:30,${lat},${lon});
out tags center;`;
      try {
        const roadData = await qo(roadQ);
        if (roadData.elements.length === 0) continue;
        const best = selectBestRoad(roadData.elements, { lat, lon });
        if (!best) continue;
        results.push({
          roadName: best.name,
          chain,
          tags: mergeWayTags(chain.tags.map((t, i) => ({ tags: t, id: chain.segmentIds[i] }))),
        });
      } catch {}
    }
    parallelLanes = groupByRoadAndProximity(results, 500);
    console.log(`  ${parallelLanes.length} parallel lane candidates`);
  }

  // Step 2c: Discover unnamed cycling chains (park paths, greenway corridors)
  console.log('Discovering unnamed cycling chains...');
  const MIN_CHAIN_LENGTH_M = 1500;
  const unchainedQ = `[out:json][timeout:120];
way["highway"~"cycleway|path"]["bicycle"~"designated|yes"][!"name"][!"crossing"](${b});
out geom tags;`;
  const unchainedData = await qo(unchainedQ);
  const unchainedWays = unchainedData.elements.filter(w => w.geometry?.length >= 2);

  const ucEpIndex = new Map();
  for (let i = 0; i < unchainedWays.length; i++) {
    const g = unchainedWays[i].geometry;
    for (const pt of [g[0], g[g.length - 1]]) {
      const key = pt.lat.toFixed(7) + ',' + pt.lon.toFixed(7);
      if (!ucEpIndex.has(key)) ucEpIndex.set(key, []);
      ucEpIndex.get(key).push(i);
    }
  }
  const ucParent = Array.from({ length: unchainedWays.length }, (_, i) => i);
  function ucFind(x) { while (ucParent[x] !== x) { ucParent[x] = ucParent[ucParent[x]]; x = ucParent[x]; } return x; }
  for (const [, indices] of ucEpIndex) {
    for (let i = 1; i < indices.length; i++) {
      const ra = ucFind(indices[0]), rb = ucFind(indices[i]);
      if (ra !== rb) ucParent[ra] = rb;
    }
  }

  const ucGroups = new Map();
  for (let i = 0; i < unchainedWays.length; i++) {
    const root = ucFind(i);
    if (!ucGroups.has(root)) ucGroups.set(root, []);
    ucGroups.get(root).push(i);
  }

  function wayLength(g) {
    let len = 0;
    for (let i = 1; i < g.length; i++) {
      const dlat = (g[i].lat - g[i - 1].lat) * 111320;
      const dlng = (g[i].lon - g[i - 1].lon) * 111320 * Math.cos(g[i].lat * Math.PI / 180);
      len += Math.sqrt(dlat * dlat + dlng * dlng);
    }
    return len;
  }

  const unnamedChains = [];
  for (const [, indices] of ucGroups) {
    let totalLen = 0;
    for (const i of indices) totalLen += wayLength(unchainedWays[i].geometry);
    if (totalLen < MIN_CHAIN_LENGTH_M) continue;

    // All naming queries use the chain's real geometry, never a midpoint.
    const chainWayIds = indices.map(i => unchainedWays[i].id).join(',');
    const chainPts = indices.flatMap(i => unchainedWays[i].geometry);

    // Name the chain from the closest named feature by real geometry.
    // Query parks (500m) and roads (100m) around the chain's actual ways,
    // then pick whichever is closest. A road 20m away beats a park 300m
    // away — the chain parallels the road, not the park.
    let chainName = null;

    // 1. Check containment first (is_in) — if the chain is INSIDE a park,
    //    that's the strongest signal. Sample multiple points along the chain.
    try {
      const samplePts = [];
      for (const i of indices) {
        const g = unchainedWays[i].geometry;
        samplePts.push(g[0], g[Math.floor(g.length / 2)], g[g.length - 1]);
      }
      for (const pt of samplePts) {
        if (chainName) break;
        try {
          const isInData = await qo(`[out:json][timeout:15];
is_in(${pt.lat},${pt.lon})->.a;
area.a["leisure"~"park|nature_reserve"]["name"]->.b;
area.a["landuse"~"recreation_ground"]["name"]->.c;
area.a["natural"="wood"]["name"]->.d;
(.b; .c; .d;);
out tags;`);
          if (isInData.elements.length > 0) {
            chainName = isInData.elements[0].tags?.name;
          }
        } catch {}
      }
    } catch {}

    // 2. If not inside a park, find the closest named feature — park or road.
    //    Both are queried using the chain's real geometry, and the closest
    //    by geometry-to-geometry distance wins.
    if (!chainName) {
      const candidates = [];
      try {
        const nearParkQ = `[out:json][timeout:15];
way(id:${chainWayIds})->.chain;
(way["leisure"="park"]["name"](around.chain:500);
relation["leisure"="park"]["name"](around.chain:500);
way["natural"="wood"]["name"](around.chain:500);
relation["natural"="wood"]["name"](around.chain:500););
out geom tags;`;
        const nearParkData = await qo(nearParkQ);
        candidates.push(...rankByGeomDistance(chainPts, nearParkData.elements));
      } catch {}
      try {
        const roadQ = `[out:json][timeout:15];
way(id:${chainWayIds})->.chain;
way["highway"~"^(primary|secondary|tertiary|residential)$"]["name"](around.chain:100);
out geom tags;`;
        const roadData = await qo(roadQ);
        candidates.push(...rankByGeomDistance(chainPts, roadData.elements));
      } catch {}
      candidates.sort((a, b) => a.dist - b.dist);
      if (candidates.length > 0) chainName = candidates[0].name;
    }

    if (!chainName) continue;

    const _ways = indices.map(i => unchainedWays[i].geometry);
    const anchors = [];
    for (const i of indices) {
      const g = unchainedWays[i].geometry;
      anchors.push([g[0].lon, g[0].lat]);
      anchors.push([g[g.length - 1].lon, g[g.length - 1].lat]);
    }
    const tags = mergeWayTags(indices.map(i => unchainedWays[i]));

    osmNamedWays.push({
      name: chainName,
      wayCount: indices.length,
      tags,
      anchors,
      osmNames: [chainName],
      _ways,
    });
    unnamedChains.push(chainName);
  }
  if (unnamedChains.length > 0) {
    console.log(`  Found ${unnamedChains.length} unnamed chains >= ${MIN_CHAIN_LENGTH_M / 1000}km`);
  }

  // Step 3: Build entries from scratch
  console.log('Building entries from scratch...');
  const entries = buildEntries(osmRelations, osmNamedWays, parallelLanes, manualEntries);

  // Enrich manual entries whose relations fell outside bbox
  const discoveredRelationIds = new Set(osmRelations.map(r => r.id));
  await enrichOutOfBoundsRelations(entries, discoveredRelationIds);

  // Enrich relation entries with _ways (transient geometry) for park
  // containment. NOT anchors — anchors are for Overpass name lookups only
  // (see AGENTS.md). _ways is stripped before YAML output.
  const needWays = entries.filter(e => e.osm_relations?.length > 0 && !e._ways?.length);
  if (needWays.length > 0) {
    const relIds = needWays.flatMap(e => e.osm_relations);
    const q = `[out:json][timeout:120];\n(\n${relIds.map(id => `  relation(${id});`).join('\n')}\n);\nout geom;`;
    try {
      const data = await qo(q);
      const byId = new Map();
      for (const el of data.elements) {
        if (!byId.has(el.id) && el.members) {
          // Extract way geometries as _ways for spatial operations
          const ways = [];
          for (const m of el.members) {
            if (m.type === 'way' && m.geometry?.length >= 2) {
              ways.push(m.geometry);
            }
          }
          if (ways.length > 0) byId.set(el.id, ways);
        }
      }
      let enriched = 0;
      for (const entry of needWays) {
        for (const relId of entry.osm_relations) {
          const ways = byId.get(relId);
          if (ways) {
            entry._ways = ways;
            enriched++;
            break;
          }
        }
      }
      if (enriched > 0) console.log(`  Enriched ${enriched} relation entries with anchors`);
    } catch (err) {
      console.error(`  Relation anchor enrichment failed: ${err.message}`);
    }
  }

  // Step 4: Auto-group nearby trail segments (with park containment)
  const grouped = await autoGroupNearbyPaths({ entries, markdownSlugs, queryOverpass: qo, bbox: b });

  // Step 5: Super-network attributes (from OSM superroutes)
  let superNetworks = [];
  let allNetSources = [];
  if (a.discoverNetworks) {
    console.log('Discovering super-networks (OSM superroutes)...');
    const networks = await discoverNetworks({ bbox: b, queryOverpass: qo });
    if (networks.length > 0) {
      // Promoted sub-superroutes (like Ottawa River Pathway) become real
      // network entries with members. Top-level superroutes become attributes.
      const promoted = networks.filter(n => n._promoted);
      allNetSources.push(...networks.filter(n => !n._promoted));

      // Add promoted networks as type: network entries
      for (const net of promoted) {
        const byRelation = new Map();
        for (const entry of grouped) {
          for (const relId of entry.osm_relations ?? []) byRelation.set(relId, entry);
        }
        const memberRefs = [];
        for (const relId of net._member_relations || []) {
          const member = byRelation.get(relId);
          if (member && member.type !== 'network') {
            // Remove from old network's _memberRefs if reassigning
            if (member._networkRef && member._networkRef._memberRefs) {
              member._networkRef._memberRefs = member._networkRef._memberRefs.filter(m => m !== member);
            }
            memberRefs.push(member);
          }
        }
        // Absorb same-named entries and merge same-named auto-group networks.
        // Standalone fragments get _networkRef. Auto-group networks with the
        // same base name (e.g. "Ottawa River Pathway Network") get their
        // _memberRefs transferred and the auto-group network is emptied.
        const netNameLower = net.name.toLowerCase();

        // First: merge any auto-group network with the same base name
        for (const entry of grouped) {
          if (entry.type !== 'network') continue;
          if (entry === net) continue;
          const entryNameLower = entry.name?.toLowerCase().replace(/ (trails|network)$/i, '');
          if (entryNameLower !== netNameLower) continue;
          // Transfer _memberRefs from auto-group network to promoted network
          for (const sub of entry._memberRefs || []) {
            if (!memberRefs.includes(sub)) {
              memberRefs.push(sub);
            }
          }
          entry._memberRefs = []; // will be cleaned up as zombie
        }

        // Then: absorb orphaned same-named entries
        for (const entry of grouped) {
          if (entry.type === 'network') continue;
          if (entry._networkRef) continue;
          if (entry.name?.toLowerCase() !== netNameLower) continue;
          if (!memberRefs.includes(entry)) {
            memberRefs.push(entry);
          }
        }

        if (memberRefs.length >= 2) {
          const networkEntry = {
            name: net.name,
            type: 'network',
            _memberRefs: memberRefs,
            osm_relations: net.osm_relations,
          };
          if (net.name_fr) networkEntry.name_fr = net.name_fr;
          if (net.operator) networkEntry.operator = net.operator;
          if (net.wikidata) networkEntry.wikidata = net.wikidata;
          if (net.wikipedia) networkEntry.wikipedia = net.wikipedia;
          grouped.push(networkEntry);
          // Assign _networkRef on all members
          for (const m of memberRefs) {
            m._networkRef = networkEntry;
          }
          console.log(`  Added promoted network: ${net.name} (${memberRefs.length} members)`);
        }
        delete net._promoted;
        delete net._member_relations;
      }

    }

    // Discover route-system networks (e.g. Crosstown Bikeways from cycle_network tags)
    const routeSystemNets = await discoverRouteSystemNetworks({ bbox: b, queryOverpass: qo });
    if (routeSystemNets.length > 0) {
      allNetSources.push(...routeSystemNets);
    }

    // Create all superroute + route-system networks in one call so byRelation
    // is built once. This prevents the second batch from flattening the first.
    if (allNetSources.length > 0) {
      console.log('Creating superroute & route-system networks...');
      superNetworks = addSuperrouteNetworks(grouped, allNetSources);
    }
  }

  // Step 6: Wikidata enrichment
  console.log('Enriching with Wikidata...');
  const wdCount = await enrichWithWikidata(grouped);
  if (wdCount > 0) console.log(`  Enriched ${wdCount} entries`);

  // Step 7: MTB detection
  detectMtb(grouped);
  const mtbCount = grouped.filter(e => e.mtb).length;
  if (mtbCount > 0) console.log(`  Labelled ${mtbCount} entries as MTB`);

  // Step 7b: Derive path_type from OSM tags (depends on mtb from step 7)
  for (const entry of grouped) {
    const pt = derivePathType(entry);
    if (pt) entry.path_type = pt;
  }

  // Step 8a: Remove standalone entries that duplicate a same-named network.
  // e.g. "Crosstown Bikeway 2" route (relation 10986223) is redundant with
  // the "Crosstown Bikeway 2" network (which absorbed 10986223 into its osm_relations).
  {
    const networksByName = new Map();
    for (const e of grouped) {
      if (e.type !== 'network') continue;
      networksByName.set(e.name.toLowerCase(), e);
    }
    const before = grouped.length;
    for (let i = grouped.length - 1; i >= 0; i--) {
      const e = grouped[i];
      if (e.type === 'network') continue;
      if (!e.osm_relations?.length) continue;
      const net = networksByName.get(e.name.toLowerCase());
      if (!net) continue;
      const netRelIds = new Set(net.osm_relations ?? []);
      if (e.osm_relations.every(id => netRelIds.has(id))) {
        // Remove from its network's _memberRefs before splicing
        if (e._networkRef && e._networkRef._memberRefs) {
          e._networkRef._memberRefs = e._networkRef._memberRefs.filter(m => m !== e);
        }
        grouped.splice(i, 1);
      }
    }
    if (grouped.length < before) {
      console.log(`  Removed ${before - grouped.length} same-named entries absorbed into networks`);
    }
  }

  // Step 8b: Apply markdown overrides.
  // member_of has special handling (network reassignment). All other fields
  // are simple overwrites — the human value replaces the pipeline value.
  if (markdownOverrides.size > 0) {
    for (const [mdSlug, override] of markdownOverrides) {
      const entry = grouped.find(e => e.type !== 'network' && slugify(e.name) === mdSlug);
      if (!entry) continue;

      // Simple field overwrites (path_type, operator, etc.)
      for (const [field, value] of Object.entries(override)) {
        if (field === 'member_of') continue; // handled below
        entry[field] = value;
      }

      if (!override.member_of) continue;

      const targetNet = grouped.find(e =>
        e.type === 'network' && slugify(e.name) === override.member_of
      );
      if (!targetNet) {
        throw new Error(
          `Markdown override: ${mdSlug} has member_of: "${override.member_of}" ` +
          `but no network with that slug exists. Check ${mdSlug}.md frontmatter.`
        );
      }

      // Remove from old network's _memberRefs
      if (entry._networkRef && entry._networkRef._memberRefs) {
        entry._networkRef._memberRefs = entry._networkRef._memberRefs.filter(m => m !== entry);
      }

      entry._networkRef = targetNet;
      if (!targetNet._memberRefs) targetNet._memberRefs = [];
      if (!targetNet._memberRefs.includes(entry)) {
        targetNet._memberRefs.push(entry);
      }
    }
  }

  // Scrub self-references: a network's _memberRefs must not contain itself
  for (const e of grouped) {
    if (e.type !== 'network' || !e._memberRefs) continue;
    e._memberRefs = e._memberRefs.filter(m => m !== e);
  }

  // Cleanup: remove zombie networks with 0 members (flattened into superroute)
  const zombies = grouped.filter(e => e.type === 'network' && (!e._memberRefs || e._memberRefs.length === 0));
  if (zombies.length > 0) {
    for (const z of zombies) {
      const idx = grouped.indexOf(z);
      if (idx !== -1) grouped.splice(idx, 1);
    }
    console.log(`  Removed ${zombies.length} empty networks`);
  }

  // Step 9: Final resolution — compute slugs once, resolve all refs to strings
  const slugMap = computeSlugs(grouped);
  for (const entry of grouped) {
    if (entry._networkRef) {
      entry.member_of = slugMap.get(entry._networkRef);
      delete entry._networkRef;
    }
    if (entry._superNetworkRef) {
      entry.super_network = slugMap.get(entry._superNetworkRef);
      delete entry._superNetworkRef;
    }
    if (entry._memberRefs) {
      entry.members = entry._memberRefs.map(ref => slugMap.get(ref)).filter(Boolean);
      delete entry._memberRefs;
    }
    entry.slug = slugMap.get(entry);
  }

  // Resolve superNetworks metadata slugs from final slugMap
  for (const meta of superNetworks) {
    if (meta._entryRef) {
      meta.slug = slugMap.get(meta._entryRef);
      delete meta._entryRef;
    }
  }

  // Step 9b: Remove ghost entries — named-way entries that duplicate relation
  // entries with parenthetical variants. E.g., named ways "Ottawa River Pathway"
  // create entries alongside relation entries "Ottawa River Pathway (east)".
  // The ghost entry has no osm_relations and its name matches a relation's base name.
  // We remove it and clean up any network member references to it.
  if (relationBaseNames.size > 0) {
    const before = grouped.length;
    for (let i = grouped.length - 1; i >= 0; i--) {
      const e = grouped[i];
      if (e.type === 'network') continue;
      if (e.osm_relations?.length > 0) continue; // keep relation entries
      const baseName = e.name?.toLowerCase();
      if (!baseName || !relationBaseNames.has(baseName)) continue;
      // This entry's name matches a relation's base name but has no relation IDs
      // — it's a ghost from named-way discovery. Remove it.
      const slug = e.slug;
      grouped.splice(i, 1);
      // Clean up network member references
      for (const net of grouped) {
        if (net.members && slug) {
          const idx = net.members.indexOf(slug);
          if (idx !== -1) net.members.splice(idx, 1);
        }
      }
    }
    if (grouped.length < before) {
      console.log(`  Removed ${before - grouped.length} ghost entries (named-way duplicates of relations)`);
    }
  }

  return { entries: grouped, superNetworks, slugMap };
}

// ---------------------------------------------------------------------------
// main() — thin wrapper: load config, run pipeline, write YAML
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Building bikepaths.yml for ${args.city} (bbox: ${bbox})`);

  const manualEntries = loadManualEntries();
  const markdownSlugs = loadMarkdownSlugs();
  const bikePathsDir = path.join(dataDir, 'bike-paths');
  const markdownOverrides = parseMarkdownOverrides(bikePathsDir);

  const { entries, superNetworks, slugMap } = await buildBikepathsPipeline({
    queryOverpass,
    bbox,
    adapter,
    manualEntries,
    markdownSlugs,
    markdownOverrides,
  });

  // Write output
  const networkEntries = entries.filter(e => e.type === 'network');
  const memberEntries = entries.filter(e => e.member_of);
  if (args.dryRun) {
    console.log('\n--- DRY RUN — would write: ---');
    for (const entry of entries) {
      const slug = slugMap.get(entry) || slugify(entry.name);
      const source = entry.type === 'network' ? `network (${entry.members?.length || 0} members)` :
        entry.member_of ? `member of ${entry.member_of}` :
        entry.osm_relations ? `relation ${entry.osm_relations[0]}` :
        entry.parallel_to ? `parallel to "${entry.parallel_to}"` :
        `name "${entry.osm_names?.[0] || entry.name}"`;
      console.log(`  ${slug}: ${entry.name} (${source})`);
    }
    console.log(`\nTotal: ${entries.length} entries (${networkEntries.length} networks, ${memberEntries.length} members, ${superNetworks.length} super-networks)`);
  } else {
    // Slugs already set by the resolution pass — strip transient fields
    for (const entry of entries) {
      delete entry._ways;
      delete entry._member_relations;
      delete entry._parkName;
    }
    for (const entry of entries) {
      if (entry.anchors?.length > 2) {
        const lngs = entry.anchors.map(a => a[0]);
        const lats = entry.anchors.map(a => a[1]);
        entry.anchors = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
      }
    }
    const yamlData = { bike_paths: entries };
    if (superNetworks.length > 0) yamlData.super_networks = superNetworks;
    const output = yaml.dump(yamlData, { lineWidth: -1, noRefs: true });
    fs.writeFileSync(bikepathsPath, output);
    console.log(`\nWrote ${entries.length} entries (${networkEntries.length} networks, ${memberEntries.length} members) to ${bikepathsPath}`);
  }
}

if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
