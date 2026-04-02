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
import { queryOverpass } from './lib/overpass.mjs';
import { haversineM } from './lib/geo.mjs';
import { slugify } from './lib/slugify.mjs';
import { loadCityAdapter } from './lib/city-adapter.mjs';
import { chainSegments } from './lib/chain-segments.mjs';
import { selectBestRoad } from './lib/select-best-road.mjs';
import { defaultParallelLaneFilter } from './lib/city-adapter.mjs';
import { autoGroupNearbyPaths, computeSlugs } from './lib/auto-group.mjs';
import { discoverNetworks } from './lib/discover-networks.mjs';
import { enrichWithWikidata } from './lib/wikidata.mjs';

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

  const namedPaths = [];
  for (const [name, ways] of byName) {
    // Use actual way endpoints as anchors (not bbox corners) so touching trails cluster
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

    namedPaths.push({
      name,
      wayCount: ways.length,
      tags: mergeWayTags(ways),
      anchors,
      osmNames: [name],
      _ways: ways.filter(w => w.geometry?.length >= 2).map(w => w.geometry),
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

/**
 * Resolve network _member_relations to slugs and assign member_of to members.
 */
// Resolve network _member_relations (relation IDs) to slugs using the
// centralized slug map. Assigns member_of on member entries.
//
// Primary network: when a path belongs to multiple networks, the most
// specific one wins (smallest member count). We process largest-first
// so the smaller one overwrites.
//
// Only top-level superroutes reach here — sub-superroutes were already
// flattened by discoverNetworks (see discover-networks.mjs).
function resolveNetworkMembers(entries, slugMap, networks) {
  // Build relation ID → entry lookup
  const byRelation = new Map();
  for (const entry of entries) {
    for (const relId of entry.osm_relations ?? []) {
      byRelation.set(relId, entry);
    }
  }

  // Sort networks largest-first so smallest (most specific) overwrites
  const sorted = [...networks].sort(
    (a, b) => (b._member_relations?.length || 0) - (a._member_relations?.length || 0)
  );

  for (const network of sorted) {
    const networkSlug = slugMap.get(network);
    if (!networkSlug) continue;

    const memberSlugs = [];
    for (const relId of network._member_relations || []) {
      const member = byRelation.get(relId);
      if (member && member.type !== 'network') {
        const memberSlug = slugMap.get(member);
        if (memberSlug) {
          memberSlugs.push(memberSlug);
          member.member_of = networkSlug;
        }
      }
    }
    network.members = memberSlugs;
    delete network._member_relations;
  }

  // Remove standalone entries for same-named routes absorbed into networks.
  // When a network absorbed a child with the same name (see discover-networks.mjs),
  // the child's relation ID was added to the network's osm_relations. But the
  // child may also exist as a standalone entry from step 1 (discoverOsmRelations).
  // Remove it — the network IS that path. This prevents slug collisions like
  // "crosstown-bikeway-2-1" (route) vs "crosstown-bikeway-2-2" (network).
  const networkRelationIds = new Set();
  for (const network of networks) {
    for (const relId of network.osm_relations || []) {
      networkRelationIds.add(relId);
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'network') continue;
    // If ALL of this entry's relation IDs are owned by a network, remove it
    if (entry.osm_relations?.length > 0 &&
        entry.osm_relations.every(id => networkRelationIds.has(id))) {
      entries.splice(i, 1);
    }
  }

  // Drop networks whose members didn't resolve (outside bbox, filtered out).
  // A network page with 0-1 members isn't useful — it's just metadata about
  // the path belonging to a larger system, not a network worth its own page.
  const MIN_RESOLVED_MEMBERS = 2;
  const toDrop = networks.filter(n => (n.members?.length || 0) < MIN_RESOLVED_MEMBERS);
  for (const network of toDrop) {
    // Undo member_of on any entries that pointed to this network
    const networkSlug = slugMap.get(network);
    for (const entry of entries) {
      if (entry.member_of === networkSlug) delete entry.member_of;
    }
    // Remove the network entry from the entries array
    const idx = entries.indexOf(network);
    if (idx !== -1) entries.splice(idx, 1);
    console.log(`  Dropped network "${network.name}": only ${network.members?.length || 0} member(s) resolved`);
  }
  // Also remove from the networks array so the caller's count is accurate
  for (const n of toDrop) {
    const idx = networks.indexOf(n);
    if (idx !== -1) networks.splice(idx, 1);
  }

  const assigned = entries.filter(e => e.member_of).length;
  if (assigned > 0) console.log(`  Assigned primary network to ${assigned} entries`);
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

async function main() {
  console.log(`Building bikepaths.yml for ${args.city} (bbox: ${bbox})`);

  // Load manual additions
  const manualEntries = loadManualEntries();

  // Discover from OSM
  const osmRelations = await discoverOsmRelations();
  const osmNamedWays = await discoverOsmNamedWays();
  const parallelLanes = await discoverParallelLanes();

  // Build entries from scratch
  const entries = buildEntries(osmRelations, osmNamedWays, parallelLanes, manualEntries);

  // Enrich manual entries with out-of-bounds relation data
  const discoveredRelationIds = new Set(osmRelations.map(r => r.id));
  await enrichOutOfBoundsRelations(entries, discoveredRelationIds);

  // Discover networks (superroutes)
  let networks = [];
  if (adapter.discoverNetworks) {
    console.log('Discovering cycling networks...');
    networks = await discoverNetworks({ bbox, queryOverpass });
    entries.push(...networks);
  }

  // Auto-group nearby trail segments
  const markdownSlugs = loadMarkdownSlugs();
  const grouped = await autoGroupNearbyPaths({ entries, markdownSlugs, queryOverpass });

  // Centralized slug computation — first pass for member resolution
  let slugMap = computeSlugs(grouped);

  // Resolve network members and assign member_of.
  // This may remove entries (same-named routes absorbed into networks),
  // so we recompute slugs afterward for clean URLs.
  if (networks.length > 0) {
    resolveNetworkMembers(grouped, slugMap, networks);
    slugMap = computeSlugs(grouped);
  }

  // Wikidata enrichment
  console.log('Enriching with Wikidata...');
  const wdCount = await enrichWithWikidata(grouped);
  if (wdCount > 0) console.log(`  Enriched ${wdCount} entries`);

  // Write output
  if (args.dryRun) {
    console.log('\n--- DRY RUN — would write: ---');
    for (const entry of grouped) {
      const slug = slugMap.get(entry) || slugify(entry.name);
      const source = entry.type === 'network' ? `network (${entry.members?.length || 0} members)` :
        entry.grouped_from ? `group of ${entry.grouped_from.length}` :
        entry.osm_relations ? `relation ${entry.osm_relations[0]}` :
        entry.parallel_to ? `parallel to "${entry.parallel_to}"` :
        `name "${entry.osm_names?.[0] || entry.name}"`;
      console.log(`  ${slug}: ${entry.name} (${source})`);
    }
    console.log(`\nTotal: ${grouped.length} entries (${grouped.filter(e => e.grouped_from).length} groups, ${networks.length} networks)`);
  } else {
    // Strip transient fields before YAML output
    for (const entry of grouped) {
      delete entry._ways;
      delete entry._member_relations;
    }
    // Compact anchors to bbox before writing — full endpoints are only needed in memory for clustering
    for (const entry of grouped) {
      if (entry.anchors?.length > 2) {
        const lngs = entry.anchors.map(a => a[0]);
        const lats = entry.anchors.map(a => a[1]);
        entry.anchors = [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
      }
    }
    const output = yaml.dump({ bike_paths: grouped }, { lineWidth: -1, noRefs: true });
    fs.writeFileSync(bikepathsPath, output);
    console.log(`\nWrote ${grouped.length} entries to ${bikepathsPath}`);
  }
}

// ---------------------------------------------------------------------------
// Testable pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Testable pipeline entry point. Runs discovery + build, returns entries array.
 * No file I/O — caller decides what to do with the result.
 *
 * @param {object} opts
 * @param {Function} opts.queryOverpass — async (q) => { elements: [] }
 * @param {string} opts.bbox — "south,west,north,east"
 * @param {object} opts.adapter — city adapter (from city-adapter.mjs)
 * @param {Array} [opts.manualEntries] — manual entries (replaces existing param)
 * @returns {Promise<Array>} built entries
 */
export async function buildBikepathsPipeline({ queryOverpass: qo, bbox: b, adapter: a, manualEntries = [], existing = [] }) {
  const filter = (a.parallelLaneFilter || defaultParallelLaneFilter);

  // Step 1: relations
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

  // Step 2: named ways
  const queries = a.namedWayQueries(b);
  const allWayElements = [];
  for (const { label, q } of queries) {
    try {
      const data = await qo(q);
      allWayElements.push(...data.elements);
    } catch {}
  }
  const waysByName = new Map();
  for (const el of allWayElements) {
    const name = el.tags?.name;
    if (!name) continue;
    if (!waysByName.has(name)) waysByName.set(name, []);
    waysByName.get(name).push(el);
  }
  const osmNamedWays = [];
  for (const [name, ways] of waysByName) {
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
    osmNamedWays.push({
      name,
      wayCount: ways.length,
      tags: mergeWayTags(ways),
      anchors,
      osmNames: [name],
      _ways: ways.filter(w => w.geometry?.length >= 2).map(w => w.geometry),
    });
  }

  // Step 2b: parallel lanes
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
  }

  // Build entries from scratch (backwards-compat: merge manual + existing as seed)
  const seed = manualEntries.length > 0 ? manualEntries : existing;
  const entries = buildEntries(osmRelations, osmNamedWays, parallelLanes, seed);
  return entries;
}

if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
