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

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--city') args.city = process.argv[++i];
  if (process.argv[i] === '--dry-run') args.dryRun = true;
}
if (!args.city) {
  console.error('Usage: node scripts/build-bikepaths.mjs --city <city>');
  process.exit(1);
}

const dataDir = path.resolve('..', args.city);
const bikepathsPath = path.join(dataDir, 'bikepaths.yml');

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
const bbox = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;

// Load city adapter for region-specific queries
const adapter = loadCityAdapter(args.city);

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

function mergeData(existing, osmRelations, osmNamedWays, catastroSegments) {
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

  const merged = mergeData(existing, osmRelations, osmNamedWays, externalSegments);

  // Enrich any manually added relations that fell outside the query bounds
  const discoveredRelationIds = new Set(osmRelations.map(r => r.id));
  await enrichOutOfBoundsRelations(merged, discoveredRelationIds);

  if (args.dryRun) {
    console.log('\n--- DRY RUN — would write: ---');
    const newEntries = merged.slice(existing.length);
    for (const entry of newEntries) {
      const slug = entry.slug || slugify(entry.name);
      const source = entry.osm_relations ? `relation ${entry.osm_relations[0]}` : `name "${entry.osm_names?.[0] || entry.name}"`;
      console.log(`  + ${slug}: ${entry.name} (${source})`);
    }
    console.log(`\nTotal: ${existing.length} existing + ${newEntries.length} new = ${merged.length}`);
  } else {
    const output = yaml.dump({ bike_paths: merged }, { lineWidth: -1, noRefs: true });
    fs.writeFileSync(bikepathsPath, output);
    console.log(`\nWrote ${merged.length} entries to ${bikepathsPath}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
