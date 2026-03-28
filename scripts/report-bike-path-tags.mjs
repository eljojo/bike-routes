#!/usr/bin/env node

/**
 * Report which routes should (or shouldn't) have the "bike path" tag.
 *
 * Fetches actual OSM geometry for every bike path with osm_relations,
 * then checks what percentage of each route's GPX trackpoints fall
 * within 100m of real path geometry.
 *
 * Usage:
 *   node scripts/report-bike-path-tags.mjs --city ottawa
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { haversineM } from './lib/geo.mjs';
import { queryOverpass } from './lib/overpass.mjs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--city') args.city = process.argv[++i];
  if (process.argv[i] === '--threshold') args.threshold = +process.argv[++i];
}
if (!args.city) {
  console.error('Usage: node scripts/report-bike-path-tags.mjs --city <city>');
  process.exit(1);
}

const THRESHOLD_M = args.threshold || 100;
const BIKE_PATH_PERCENT = 50;
const dataDir = path.resolve(args.city);

// ---------------------------------------------------------------------------
// Load bike paths and fetch geometry from Overpass
// ---------------------------------------------------------------------------

const bikepathsPath = path.join(dataDir, 'bikepaths.yml');
const bikepathsData = yaml.load(fs.readFileSync(bikepathsPath, 'utf8'));

// Collect unique OSM relation IDs, skip roads
const relationIds = new Set();
for (const bp of bikepathsData.bike_paths) {
  if (!bp.osm_relations) continue;
  if (['tertiary', 'secondary', 'primary', 'residential', 'unclassified'].includes(bp.highway)) continue;
  for (const id of bp.osm_relations) relationIds.add(id);
}

console.log(`Found ${relationIds.size} OSM relations to fetch geometry for...`);

// Fetch geometry for all relations in batches
const BATCH_SIZE = 20;
const allGeomPoints = []; // flat array of [lng, lat] from all path geometries

const relationArray = [...relationIds];
for (let i = 0; i < relationArray.length; i += BATCH_SIZE) {
  const batch = relationArray.slice(i, i + BATCH_SIZE);
  const idFilter = batch.map((id) => `relation(${id});`).join('\n  ');
  const query = `[out:json][timeout:120];
(
  ${idFilter}
);
(._;>;);
out geom;`;

  try {
    const data = await queryOverpass(query);
    for (const el of data.elements || []) {
      if (el.type === 'way' && el.geometry) {
        for (const pt of el.geometry) {
          allGeomPoints.push([pt.lon, pt.lat]);
        }
      }
    }
    process.stdout.write(`  fetched batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(relationArray.length / BATCH_SIZE)} (${allGeomPoints.length} points so far)\n`);
  } catch (err) {
    console.error(`  batch failed: ${err.message}`);
  }
}

console.log(`\nLoaded ${allGeomPoints.length} geometry points from OSM\n`);

// ---------------------------------------------------------------------------
// Spatial index for fast proximity checks
// ---------------------------------------------------------------------------

const GRID_SIZE = 0.001; // ~100m cells
const grid = new Map();
for (const [lng, lat] of allGeomPoints) {
  const key = `${Math.floor(lat / GRID_SIZE)},${Math.floor(lng / GRID_SIZE)}`;
  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push([lng, lat]);
}

function isNearBikePath(lng, lat) {
  const gLat = Math.floor(lat / GRID_SIZE);
  const gLng = Math.floor(lng / GRID_SIZE);
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      const key = `${gLat + dLat},${gLng + dLng}`;
      const cell = grid.get(key);
      if (!cell) continue;
      for (const anchor of cell) {
        if (haversineM([lng, lat], anchor) <= THRESHOLD_M) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Parse GPX
// ---------------------------------------------------------------------------

function parseGpxPoints(gpxContent) {
  const points = [];
  const re = /lat="([^"]+)"\s+lon="([^"]+)"/g;
  let m;
  while ((m = re.exec(gpxContent)) !== null) {
    points.push([+m[2], +m[1]]); // [lng, lat]
  }
  return points;
}

// ---------------------------------------------------------------------------
// Analyze routes
// ---------------------------------------------------------------------------

const routesDir = path.join(dataDir, 'routes');
const routeSlugs = fs.readdirSync(routesDir).filter((d) => {
  return fs.statSync(path.join(routesDir, d)).isDirectory();
});

const results = [];

for (const slug of routeSlugs) {
  const indexPath = path.join(routesDir, slug, 'index.md');
  const gpxPath = path.join(routesDir, slug, 'main.gpx');

  if (!fs.existsSync(indexPath) || !fs.existsSync(gpxPath)) continue;

  const content = fs.readFileSync(indexPath, 'utf8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) continue;
  const fm = yaml.load(fmMatch[1]);
  const tags = fm.tags || [];
  const hasBikePathTag = tags.includes('bike path');

  const gpxContent = fs.readFileSync(gpxPath, 'utf8');
  const points = parseGpxPoints(gpxContent);
  if (points.length === 0) continue;

  // Sample ~500 points evenly for speed
  const sampleRate = Math.max(1, Math.floor(points.length / 500));
  let onPath = 0;
  let sampled = 0;
  for (let i = 0; i < points.length; i += sampleRate) {
    sampled++;
    if (isNearBikePath(points[i][0], points[i][1])) onPath++;
  }

  const percent = Math.round((onPath / sampled) * 100);

  results.push({
    slug,
    percent,
    hasBikePathTag,
    shouldHaveTag: percent >= BIKE_PATH_PERCENT,
    distance: fm.distance_km,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

results.sort((a, b) => b.percent - a.percent);

console.log(`Route bike-path overlap report (threshold: ${THRESHOLD_M}m, tag if ≥${BIKE_PATH_PERCENT}%)\n`);
console.log('  %  Tag  Slug');
console.log('---  ---  ' + '-'.repeat(50));

const issues = [];

for (const r of results) {
  const tagMarker = r.hasBikePathTag ? ' ✓ ' : '   ';
  const flag =
    r.shouldHaveTag && !r.hasBikePathTag
      ? ' ← MISSING tag'
      : !r.shouldHaveTag && r.hasBikePathTag
        ? ' ← EXTRA tag?'
        : '';
  console.log(`${String(r.percent).padStart(3)}% ${tagMarker} ${r.slug}${flag}`);
  if (flag) issues.push(r);
}

if (issues.length > 0) {
  console.log(`\n--- Issues (${issues.length}) ---\n`);
  for (const r of issues) {
    if (r.shouldHaveTag && !r.hasBikePathTag) {
      console.log(`  ADD "bike path" tag to ${r.slug} (${r.percent}% on bike paths)`);
    } else {
      console.log(`  REVIEW "bike path" tag on ${r.slug} (only ${r.percent}% on bike paths)`);
    }
  }
} else {
  console.log('\nAll tags look correct.');
}
