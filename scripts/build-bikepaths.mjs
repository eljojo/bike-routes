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
import { discoverNetworks } from './lib/discover-networks.mjs';
import { enrichWithWikidata } from './lib/wikidata.mjs';
import { detectMtb } from './lib/detect-mtb.mjs';

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
 * Split ways with the same name into geographic clusters.
 * "Trail 20" in the Greenbelt and "Trail 20" in Gatineau Park are
 * different trails — don't merge them just because they share a name.
 * Uses single-linkage clustering: two ways are in the same cluster if
 * any of their geometry points are within maxDistM of each other.
 */
function splitWaysByProximity(ways, maxDistM) {
  if (ways.length <= 1) return [ways];

  // Get a representative point for each way (midpoint of geometry)
  const points = ways.map(w => {
    if (w.geometry?.length >= 2) {
      const mid = w.geometry[Math.floor(w.geometry.length / 2)];
      return [mid.lon, mid.lat];
    }
    if (w.center) return [w.center.lon, w.center.lat];
    return null;
  });

  // Union-find
  const parent = ways.map((_, i) => i);
  function find(i) {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }

  for (let i = 0; i < ways.length; i++) {
    if (!points[i]) continue;
    for (let j = i + 1; j < ways.length; j++) {
      if (!points[j]) continue;
      if (find(i) === find(j)) continue;
      if (haversineM(points[i], points[j]) < maxDistM) {
        parent[find(i)] = find(j);
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
      const tooFar = existing.anchors?.length > 0 && np.anchors?.length > 0 &&
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
function applySuperNetworks(entries, slugMap, networks) {
  const byRelation = new Map();
  for (const entry of entries) {
    for (const relId of entry.osm_relations ?? []) {
      byRelation.set(relId, entry);
    }
  }

  // Store super-network metadata for the Astro app
  const superNetworks = [];

  for (const network of networks) {
    const name = network.name;
    const slug = slugMap.get(network) || slugify(name);

    const meta = {
      name,
      slug,
    };
    if (network.wikidata) meta.wikidata = network.wikidata;
    if (network.wikipedia) meta.wikipedia = network.wikipedia;
    if (network.operator) meta.operator = network.operator;
    if (network.network) meta.network = network.network;
    if (network.name_fr) meta.name_fr = network.name_fr;
    if (network.wikidata_meta) meta.wikidata_meta = network.wikidata_meta;
    superNetworks.push(meta);

    // Apply super_network attribute to member entries
    let assigned = 0;
    for (const relId of network._member_relations || []) {
      const member = byRelation.get(relId);
      if (member) {
        member.super_network = slug;
        assigned++;
      }
    }
    console.log(`  Super-network: ${name} (${assigned} entries tagged)`);
  }

  return superNetworks;
}

// ---------------------------------------------------------------------------
// Helper: load markdown slugs
// ---------------------------------------------------------------------------

function loadMarkdownSlugs() {
  const bikePathsDir = path.join(dataDir, 'bike-paths');
  const slugs = new Set();
  if (fs.existsSync(bikePathsDir)) {
    for (const f of fs.readdirSync(bikePathsDir)) {
      if (f.endsWith('.md') && !f.includes('.fr.')) slugs.add(f.replace(/\.md$/, ''));
    }
  }
  return slugs;
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
 * @returns {Promise<{ entries: Array, superNetworks: Array, slugMap: Map }>}
 */
export async function buildBikepathsPipeline({ queryOverpass: qo, bbox: b, adapter: a, manualEntries = [], markdownSlugs = new Set() }) {
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
  const MAX_SAME_NAME_DISTANCE_M = 5000;
  const osmNamedWays = [];
  for (const [name, ways] of waysByName) {
    // Split ways into geographic clusters using single-linkage at 5km
    const wayClusters = splitWaysByProximity(ways, MAX_SAME_NAME_DISTANCE_M);

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

      // Include junction ways that are near THIS cluster, not all of them
      const junctionWays = (allWaysByName.get(name) || []).filter(jw => {
        if (!jw.geometry?.length) return false;
        const jwCenter = jw.geometry[Math.floor(jw.geometry.length / 2)];
        return clusterWays.some(cw => {
          if (!cw.geometry?.length) return false;
          const cwCenter = cw.geometry[Math.floor(cw.geometry.length / 2)];
          return haversineM([jwCenter.lon, jwCenter.lat], [cwCenter.lon, cwCenter.lat]) < MAX_SAME_NAME_DISTANCE_M;
        });
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

  // Step 3: Build entries from scratch
  console.log('Building entries from scratch...');
  const entries = buildEntries(osmRelations, osmNamedWays, parallelLanes, manualEntries);

  // Enrich manual entries whose relations fell outside bbox
  const discoveredRelationIds = new Set(osmRelations.map(r => r.id));
  await enrichOutOfBoundsRelations(entries, discoveredRelationIds);

  // Step 4: Auto-group nearby trail segments (with park containment)
  const grouped = await autoGroupNearbyPaths({ entries, markdownSlugs, queryOverpass: qo, bbox: b });

  // Step 5: Centralized slug computation
  let slugMap = computeSlugs(grouped);

  // Step 6: Super-network attributes (from OSM superroutes)
  let superNetworks = [];
  if (a.discoverNetworks) {
    console.log('Discovering super-networks (OSM superroutes)...');
    const networks = await discoverNetworks({ bbox: b, queryOverpass: qo });
    if (networks.length > 0) {
      console.log('Applying super-network attributes...');
      superNetworks = applySuperNetworks(grouped, slugMap, networks);
      slugMap = computeSlugs(grouped);
    }
  }

  // Step 7: Wikidata enrichment
  console.log('Enriching with Wikidata...');
  const wdCount = await enrichWithWikidata(grouped);
  if (wdCount > 0) console.log(`  Enriched ${wdCount} entries`);

  // Step 8: MTB detection
  detectMtb(grouped);
  const mtbCount = grouped.filter(e => e.mtb).length;
  if (mtbCount > 0) console.log(`  Labelled ${mtbCount} entries as MTB`);

  return { entries: grouped, superNetworks, slugMap };
}

// ---------------------------------------------------------------------------
// main() — thin wrapper: load config, run pipeline, write YAML
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Building bikepaths.yml for ${args.city} (bbox: ${bbox})`);

  const manualEntries = loadManualEntries();
  const markdownSlugs = loadMarkdownSlugs();

  const { entries, superNetworks, slugMap } = await buildBikepathsPipeline({
    queryOverpass,
    bbox,
    adapter,
    manualEntries,
    markdownSlugs,
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
    for (const entry of entries) {
      delete entry._ways;
      delete entry._member_relations;
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
