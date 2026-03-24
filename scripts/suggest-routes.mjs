#!/usr/bin/env node

/**
 * Route suggestion CLI — orchestrates the full pipeline.
 *
 * Usage:
 *   node scripts/suggest-routes.mjs \
 *     --city santiago \
 *     --source URL_OR_FILE_OR_overpass \
 *     --bounds "south,west,north,east" \
 *     --output proposals.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseCatastroFeature, parseOverpassWay } from './lib/segments.mjs';
import { detectAxes } from './lib/axes.mjs';
import { fetchPOIs, fetchCyclingWays } from './lib/overpass.mjs';
import { scoreAnchors } from './lib/anchors.mjs';
import { stitchTrips } from './lib/trips.mjs';
import { buildGPX } from './lib/gpx.mjs';
import { buildMarkdown } from './lib/markdown.mjs';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Source loading
// ---------------------------------------------------------------------------

async function loadSegments(source, bounds) {
  // Overpass source
  if (source === 'overpass') {
    if (!bounds) throw new Error('--bounds required when using --source overpass');
    console.log('[source] Fetching cycling ways from Overpass...');
    const ways = await fetchCyclingWays(bounds);
    console.log(`[source] ${ways.length} ways from Overpass`);
    return ways.map((el, i) => parseOverpassWay(el, i));
  }

  // URL source
  if (source.startsWith('http://') || source.startsWith('https://')) {
    console.log(`[source] Fetching GeoJSON from ${source}...`);
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
    const geojson = await res.json();
    console.log(`[source] ${geojson.features.length} features`);
    return geojson.features.map((f, i) => parseCatastroFeature(f, i));
  }

  // File source
  console.log(`[source] Reading GeoJSON from ${source}...`);
  const geojson = JSON.parse(readFileSync(source, 'utf8'));
  console.log(`[source] ${geojson.features.length} features`);
  return geojson.features.map((f, i) => parseCatastroFeature(f, i));
}

// ---------------------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------------------

function printSummary(routes) {
  console.log(`\n${'='.repeat(70)}`);
  console.log('ROUTE PROPOSALS SUMMARY');
  console.log(`${'='.repeat(70)}\n`);
  console.log(`Total routes: ${routes.length}\n`);

  const top = routes.slice(0, 20);
  console.log('Top 20 routes:');
  console.log(`${'─'.repeat(70)}`);
  for (const r of top) {
    const distKm = (r.totalDistanceM / 1000).toFixed(1);
    const tags = r.suggestedTags.slice(0, 4).join(', ');
    console.log(
      `  ${r.name}  ${distKm} km  ${r.infraPercent}% infra  score=${r.compositeScore}  [${tags}]`,
    );
  }
  console.log(`${'─'.repeat(70)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const city = args.city;
  const source = args.source;
  const outputPath = args.output;

  if (!city) throw new Error('--city is required');
  if (!source) throw new Error('--source is required');
  if (!outputPath) throw new Error('--output is required');

  const bounds = args.bounds
    ? args.bounds.split(',').map(Number)
    : null;

  if (bounds && bounds.length !== 4) {
    throw new Error('--bounds must be "south,west,north,east"');
  }

  // --- Pass 0: Load segments ---
  const segments = await loadSegments(source, bounds);
  console.log(`[pipeline] ${segments.length} segments loaded`);

  // --- Pass 1: Detect axes ---
  console.log('[pipeline] Detecting axes...');
  const axes = detectAxes(segments);
  console.log(`[pipeline] ${axes.length} axes detected`);

  // --- Pass 2: Fetch POIs and score anchors ---
  if (!bounds) {
    throw new Error('--bounds is required for POI fetching');
  }
  console.log('[pipeline] Fetching POIs...');
  const pois = await fetchPOIs(bounds);
  console.log(`[pipeline] ${pois.length} POIs fetched`);

  console.log('[pipeline] Scoring anchors...');
  const anchors = scoreAnchors(pois, axes);
  console.log(`[pipeline] ${anchors.length} anchors scored`);

  // --- Pass 3: Stitch trips ---
  console.log('[pipeline] Stitching routes...');
  const routes = stitchTrips(axes, anchors);
  console.log(`[pipeline] ${routes.length} routes generated`);

  // --- Print summary ---
  printSummary(routes);

  // --- Build proposals JSON ---
  const totalInfraM = axes.reduce((s, a) => s + a.totalInfraM, 0);

  const proposals = {
    city,
    generatedAt: new Date().toISOString(),
    source,
    bounds,
    summary: {
      totalSegments: segments.length,
      totalAxes: axes.length,
      totalAnchors: anchors.length,
      totalRoutes: routes.length,
      totalInfraKm: Math.round(totalInfraM / 100) / 10,
    },
    axes: axes.map((a) => ({
      name: a.name,
      slug: a.slug,
      comunas: a.comunas,
      segmentCount: a.segments.length,
      totalInfraM: Math.round(a.totalInfraM),
      gapCount: a.gapsWithinAxis.length,
      avgConditionScore: a.avgConditionScore != null
        ? Math.round(a.avgConditionScore * 10) / 10
        : null,
      videos: a.videos,
    })),
    anchors: anchors.slice(0, 100).map((a) => ({
      name: a.name,
      lat: a.lat,
      lng: a.lng,
      type: a.type,
      anchorScore: a.anchorScore,
    })),
    routes,
  };

  writeFileSync(outputPath, JSON.stringify(proposals, null, 2), 'utf8');
  console.log(`[pipeline] Wrote ${outputPath}`);

  // Quick stats
  console.log(`\nDone. ${routes.length} routes, ${axes.length} axes, ${anchors.length} anchors.`);
  console.log(`Total infrastructure: ${proposals.summary.totalInfraKm} km`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
