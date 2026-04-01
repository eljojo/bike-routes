#!/usr/bin/env node

/**
 * Build bikepaths.yml — the city's cycling infrastructure registry.
 *
 * Discovers cycling infrastructure from OSM and optionally enriches with
 * external data sources (e.g. Pedaleable catastro for Santiago).
 *
 * Region-specific behavior (OSM query patterns, external data sources) is
 * defined in lib/city-adapter.mjs.
 *
 * Usage:
 *   node scripts/build-bikepaths.mjs --city santiago
 *   node scripts/build-bikepaths.mjs --city ottawa --dry-run
 *
 * ## Merge philosophy
 *
 * bikepaths.yml is machine-owned but accepts manual additions. The merge
 * logic is additive and preserves existing entries:
 *
 * - **Entries already in the file are never removed**, even if the script's
 *   OSM query no longer returns them (e.g. paths outside the city bounds).
 * - **Hand-edited fields take precedence** over OSM data. The script only
 *   fills in fields the entry doesn't already have.
 * - **Manual one-offs are welcome.** If a path exists in OSM but falls
 *   outside the query bounds (e.g. Prescott-Russell Trail is in a
 *   neighbouring county), add it manually with its osm_relations. The
 *   next script run will enrich it with any missing OSM metadata but
 *   won't remove or duplicate it. This effectively enlarges the scope
 *   of what the script manages.
 * - The script matches existing entries by relation ID first, then by
 *   slugified name. This prevents duplicates when an entry is added
 *   manually before the script discovers it.
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
// Step 1: Discover cycling relations from OSM
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
// Step 2: Discover named cycling ways not in relations
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
    // Compute bounding box from way centers for anchors
    const lats = ways.filter(w => w.center).map(w => w.center.lat);
    const lngs = ways.filter(w => w.center).map(w => w.center.lon);
    if (lats.length === 0) continue;

    namedPaths.push({
      name,
      wayCount: ways.length,
      tags: mergeWayTags(ways),
      anchors: [
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      ],
      osmNames: [name],
    });
  }
  console.log(`  Found ${namedPaths.length} named cycling ways`);
  return namedPaths;
}

// ---------------------------------------------------------------------------
// Step 2b: Discover unnamed parallel bike lanes
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
// Step 3: Fetch external data (catastro, etc.) — city-specific
// ---------------------------------------------------------------------------

async function fetchExternalData() {
  if (!adapter.externalData) {
    console.log('No external data source for this city, skipping.');
    return [];
  }

  const { type, url } = adapter.externalData;
  if (type !== 'catastro') {
    console.log(`Unknown external data type: ${type}, skipping.`);
    return [];
  }

  console.log('Fetching catastro from pedaleable.org...');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch catastro: ${res.status}`);
  const geojson = await res.json();

  const segments = [];
  for (const feature of geojson.features) {
    const p = feature.properties;
    if (p['_inválida'] === '1') continue;

    const coords = feature.geometry.coordinates;
    const firstLine = coords[0];
    const lastLine = coords[coords.length - 1];
    const start = firstLine[0].slice(0, 2);
    const end = lastLine[lastLine.length - 1].slice(0, 2);

    segments.push({
      nombre: p.nombre || 'unnamed',
      comuna: p._comuna || 'unknown',
      quality: p._eval_graduada_pedal || null,
      clasificacion: p._eval_graduada_pedal_clasif || null,
      emplazamiento: p._emplazamiento || null,
      ancho_cm: p._ancho_cm || null,
      video: p.video || null,
      surface_type: p._tipo || null,
      start,
      end,
      center: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
    });
  }
  console.log(`  Fetched ${segments.length} catastro segments`);
  return segments;
}

// ---------------------------------------------------------------------------
// Step 4: Load existing bikepaths.yml and merge
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

function loadExisting() {
  if (!fs.existsSync(bikepathsPath)) return [];
  const { bike_paths } = yaml.load(fs.readFileSync(bikepathsPath, 'utf8'));
  return bike_paths || [];
}

/**
 * Enrich an existing entry with OSM metadata, only adding fields it doesn't
 * already have (hand-edited values take precedence).
 */
function enrichEntry(entry, tags) {
  const meta = extractOsmMetadata(tags);
  for (const [key, val] of Object.entries(meta)) {
    if (entry[key] == null) entry[key] = val;
  }
}

async function mergeData(existing, osmRelations, osmNamedWays, catastroSegments, parallelLanes = []) {
  console.log('Merging data...');

  // Index existing entries by slug and relation ID
  const bySlug = new Map();
  const byRelation = new Map();
  const byName = new Map();
  for (const entry of existing) {
    const slug = entry.slug || slugify(entry.name);
    bySlug.set(slug, entry);
    byName.set(entry.name.toLowerCase(), entry);
    if (entry.osm_relations) {
      for (const relId of entry.osm_relations) byRelation.set(relId, entry);
    }
  }

  const result = [...existing];
  let added = 0;

  // Add OSM relations not already tracked
  for (const rel of osmRelations) {
    if (byRelation.has(rel.id)) {
      // Enrich existing entry with any missing metadata
      enrichEntry(byRelation.get(rel.id), rel.tags);
      continue;
    }
    // Check by name too (might be tracked by name instead of relation)
    const slug = slugify(rel.name);
    if (bySlug.has(slug)) {
      // Entry exists by name but missing the relation ID — add it
      const entry = bySlug.get(slug);
      if (!entry.osm_relations) entry.osm_relations = [];
      entry.osm_relations.push(rel.id);
      enrichEntry(entry, rel.tags);
      continue;
    }

    // New entry with OSM metadata
    const meta = extractOsmMetadata(rel.tags);
    const entry = {
      name: rel.name,
      osm_relations: [rel.id],
      ...meta,
    };
    result.push(entry);
    bySlug.set(slug, entry);
    byRelation.set(rel.id, entry);
    added++;
  }

  // Add named ways not already tracked (by name or slug)
  for (const np of osmNamedWays) {
    const slug = slugify(np.name);
    // Enrich existing entries with metadata from ways
    const existingEntry = bySlug.get(slug) || byName.get(np.name.toLowerCase());
    if (existingEntry) {
      enrichEntry(existingEntry, np.tags);
      continue;
    }

    // Check if any existing entry has this as an osm_name
    let found = false;
    for (const entry of existing) {
      if (entry.osm_names?.some(n => n.toLowerCase() === np.name.toLowerCase())) {
        enrichEntry(entry, np.tags);
        found = true;
        break;
      }
    }
    if (found) continue;

    const meta = extractOsmMetadata(np.tags);
    const entry = {
      name: np.name,
      osm_names: np.osmNames,
      anchors: np.anchors,
      ...meta,
    };
    result.push(entry);
    bySlug.set(slug, entry);
    added++;
  }

  // Enrich entries with catastro data (Santiago-only for now)
  let enriched = 0;
  for (const seg of catastroSegments) {
    if (!seg.osmWayId) continue;

    // Find which entry this segment belongs to (by proximity to entry's anchors)
    let bestEntry = null;
    let bestDist = Infinity;
    for (const entry of result) {
      if (entry.anchors) {
        for (const anchor of entry.anchors) {
          const d = haversineM(seg.center, anchor);
          if (d < bestDist) { bestDist = d; bestEntry = entry; }
        }
      }
    }

    if (bestEntry && bestDist < 2000) {
      if (!bestEntry.segments) bestEntry.segments = [];
      // Don't add duplicate segments
      const alreadyHas = bestEntry.segments.some(s => s.osm_way === seg.osmWayId);
      if (!alreadyHas) {
        const segEntry = { osm_way: seg.osmWayId };
        if (seg.quality) segEntry.quality = seg.quality;
        if (seg.video) segEntry.video = seg.video;
        if (seg.surface_type) segEntry.surface_type = seg.surface_type;
        if (seg.ancho_cm) segEntry.width_cm = seg.ancho_cm;
        bestEntry.segments.push(segEntry);
        enriched++;
      }
    }
  }

  // --- Parallel lanes (pass 2: spatial dedup + merge) ---
  if (parallelLanes.length > 0) {
    const { isOverlapping } = await import('./lib/spatial-dedup.mjs');

    // Load existing geometry for spatial dedup
    const geoDir = args.city ? path.resolve('.cache', 'bikepath-geometry', args.city) : null;
    const existingGeometries = [];
    if (geoDir && fs.existsSync(geoDir)) {
      for (const file of fs.readdirSync(geoDir).filter(f => f.endsWith('.geojson'))) {
        try {
          const geojson = JSON.parse(fs.readFileSync(path.join(geoDir, file), 'utf8'));
          const pts = [];
          for (const feature of geojson.features || []) {
            const coords = feature.geometry?.coordinates || [];
            const lines = feature.geometry?.type === 'LineString' ? [coords] :
                          feature.geometry?.type === 'MultiLineString' ? coords : [];
            for (const line of lines) {
              for (const c of line) pts.push([c[1], c[0]]); // [lat, lng]
            }
          }
          if (pts.length > 0) existingGeometries.push(pts);
        } catch {}
      }
    }

    let parallelAdded = 0;
    let parallelMerged = 0;
    for (const candidate of parallelLanes) {
      const slug = slugify(candidate.name);

      // If an entry with this name already exists, merge the parallel lane
      // geometry into it rather than skipping. This way roads that have both
      // painted lanes and a separated cycleway get the parallel geometry
      // resolved too. We keep the existing (worse) facts — the road's
      // highway/cycleway tags — to avoid overstating quality when only part
      // of the path is separated infrastructure.
      // TODO: in the future, mark these entries as mixed-quality so the UI
      // can show "parts of this path are separated, others are painted lanes"
      const existingEntry = bySlug.get(slug) || byName.get(candidate.name.toLowerCase());
      if (existingEntry) {
        if (!existingEntry.parallel_to) {
          existingEntry.parallel_to = candidate.parallel_to;
          parallelMerged++;
          console.log(`  ~ merged parallel geometry into: ${existingEntry.name}`);
        }
        continue;
      }

      // Skip if spatially overlapping existing geometry
      const candidatePts = candidate._chainCoords;
      let dominated = false;
      for (const existingPts of existingGeometries) {
        if (isOverlapping(candidatePts, existingPts, 30, 0.5)) {
          dominated = true;
          break;
        }
      }
      if (dominated) continue;

      // Add new entry
      const entry = {
        name: candidate.name,
        parallel_to: candidate.parallel_to,
        highway: candidate.tags.highway || 'cycleway',
        anchors: candidate.anchors,
      };
      // Add optional tags
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
      added += parallelAdded;
      console.log(`  Parallel lanes added: ${parallelAdded}, merged into existing: ${parallelMerged}`);
    }
  }

  console.log(`  Existing entries: ${existing.length}`);
  console.log(`  New entries added: ${added}`);
  if (catastroSegments.length > 0) {
    console.log(`  Catastro segments matched: ${enriched}`);
  }
  console.log(`  Total entries: ${result.length}`);

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Enrich manually added entries whose osm_relations were not found by the
 * bbox-scoped discovery query. Fetches tags directly by relation ID.
 * This is what makes manual one-offs work: add a relation ID to the file,
 * and the next script run fills in name, surface, network, etc. from OSM.
 */
async function enrichOutOfBoundsRelations(merged, discoveredRelationIds) {
  const missing = [];
  for (const entry of merged) {
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

async function main() {
  console.log(`Building bikepaths.yml for ${args.city} (bbox: ${bbox})`);

  const existing = loadExisting();
  const osmRelations = await discoverOsmRelations();
  const osmNamedWays = await discoverOsmNamedWays();
  const externalSegments = await fetchExternalData();
  const parallelLanes = await discoverParallelLanes();

  const merged = await mergeData(existing, osmRelations, osmNamedWays, externalSegments, parallelLanes);

  // Enrich any manually added relations that fell outside the query bounds
  const discoveredRelationIds = new Set(osmRelations.map(r => r.id));
  await enrichOutOfBoundsRelations(merged, discoveredRelationIds);

  if (args.dryRun) {
    console.log('\n--- DRY RUN — would write: ---');
    const newEntries = merged.slice(existing.length);
    for (const entry of newEntries) {
      const slug = entry.slug || slugify(entry.name);
      const source = entry.osm_relations ? `relation ${entry.osm_relations[0]}` : entry.parallel_to ? `parallel to "${entry.parallel_to}"` : `name "${entry.osm_names?.[0] || entry.name}"`;
      console.log(`  + ${slug}: ${entry.name} (${source})`);
    }
    console.log(`\nTotal: ${existing.length} existing + ${newEntries.length} new = ${merged.length}`);
  } else {
    const output = yaml.dump({ bike_paths: merged }, { lineWidth: -1, noRefs: true });
    fs.writeFileSync(bikepathsPath, output);
    console.log(`\nWrote ${merged.length} entries to ${bikepathsPath}`);
  }
}

/**
 * Testable pipeline entry point. Runs discovery + merge, returns entries array.
 * No file I/O — caller decides what to do with the result.
 *
 * @param {object} opts
 * @param {Function} opts.queryOverpass — async (q) => { elements: [] }
 * @param {string} opts.bbox — "south,west,north,east"
 * @param {object} opts.adapter — city adapter (from city-adapter.mjs)
 * @param {Array} opts.existing — existing bikepaths.yml entries
 * @param {string} [opts.cacheDir] — geometry cache dir for spatial dedup (optional)
 * @returns {Promise<Array>} merged entries
 */
export async function buildBikepathsPipeline({ queryOverpass: qo, bbox: b, adapter: a, existing, cacheDir }) {
  // Swap module-level bindings for the duration of this call
  const savedQo = queryOverpass, savedBbox = bbox, savedAdapter = adapter;
  // We can't reassign imports, so we call the inner functions directly.
  // Instead, just run the pipeline steps inline using the provided deps.

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
    const lats = ways.filter(w => w.center).map(w => w.center.lat);
    const lngs = ways.filter(w => w.center).map(w => w.center.lon);
    if (lats.length === 0) continue;
    osmNamedWays.push({
      name,
      wayCount: ways.length,
      tags: mergeWayTags(ways),
      anchors: [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
      osmNames: [name],
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

  // Merge
  const merged = await mergeData(existing, osmRelations, osmNamedWays, [], parallelLanes);
  return merged;
}

if (isMain) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
