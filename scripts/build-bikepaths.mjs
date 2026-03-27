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
 * Idempotent: new paths get added, existing entries keep their data.
 * Hand-edited fields (slug overrides, manual anchors) are preserved.
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
      tags: ways[0].tags || {},
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

function loadExisting() {
  if (!fs.existsSync(bikepathsPath)) return [];
  const { bike_paths } = yaml.load(fs.readFileSync(bikepathsPath, 'utf8'));
  return bike_paths || [];
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
    if (byRelation.has(rel.id)) continue;
    // Check by name too (might be tracked by name instead of relation)
    const slug = slugify(rel.name);
    if (bySlug.has(slug)) {
      // Entry exists by name but missing the relation ID — add it
      const entry = bySlug.get(slug);
      if (!entry.osm_relations) entry.osm_relations = [];
      entry.osm_relations.push(rel.id);
      continue;
    }

    // New entry
    const entry = {
      name: rel.name,
      osm_relations: [rel.id],
    };
    result.push(entry);
    bySlug.set(slug, entry);
    byRelation.set(rel.id, entry);
    added++;
  }

  // Add named ways not already tracked (by name or slug)
  for (const np of osmNamedWays) {
    const slug = slugify(np.name);
    if (bySlug.has(slug)) continue;
    if (byName.has(np.name.toLowerCase())) continue;

    // Check if any existing entry has this as an osm_name
    let found = false;
    for (const entry of existing) {
      if (entry.osm_names?.some(n => n.toLowerCase() === np.name.toLowerCase())) {
        found = true;
        break;
      }
    }
    if (found) continue;

    const entry = {
      name: np.name,
      osm_names: np.osmNames,
      anchors: np.anchors,
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

async function main() {
  console.log(`Building bikepaths.yml for ${args.city} (bbox: ${bbox})`);

  const existing = loadExisting();
  const osmRelations = await discoverOsmRelations();
  const osmNamedWays = await discoverOsmNamedWays();
  const externalSegments = await fetchExternalData();

  const merged = mergeData(existing, osmRelations, osmNamedWays, externalSegments);

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
