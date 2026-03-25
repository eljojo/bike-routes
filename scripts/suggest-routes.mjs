#!/usr/bin/env node --max-old-space-size=16384

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

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { parseCatastroFeature, parseOverpassWay } from './lib/segments.mjs';
import { detectAxes } from './lib/axes.mjs';
import { fetchPOIs, fetchCyclingWays, fetchMetroStations, fetchWaterways, fetchMotorways, fetchRoadNetwork, fetchZonePOIs, fetchTreeRows, fetchBikeParking } from './lib/overpass.mjs';
import { detectZones } from './lib/zones.mjs';
import { haversineM, allCoords } from './lib/geo.mjs';

/** Sample N evenly-spaced points along a coordinate array. */
function samplePoints(coords, n) {
  if (coords.length <= n) return coords;
  const step = Math.max(1, Math.floor(coords.length / n));
  const pts = [];
  for (let i = 0; i < coords.length; i += step) pts.push(coords[i]);
  return pts;
}
import { scoreAnchors, clusterDestinationZones } from './lib/anchors.mjs';
import { stitchTrips } from './lib/trips.mjs';
import { buildRoadGraph } from './lib/roads.mjs';
import { buildGPX } from './lib/gpx.mjs';
import { buildMarkdown } from './lib/markdown.mjs';

// ---------------------------------------------------------------------------
// Place loading (from data repo)
// ---------------------------------------------------------------------------

/**
 * Load places from a city's places/ directory as high-priority anchors.
 * These are hand-curated by local riders — better than OSM POIs.
 */
function loadPlaces(placesDir) {
  if (!existsSync(placesDir)) return [];

  const files = readdirSync(placesDir).filter((f) => f.endsWith('.md'));
  const places = [];

  for (const file of files) {
    const raw = readFileSync(join(placesDir, file), 'utf8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;

    const fm = yaml.load(fmMatch[1]);
    if (!fm.lat || !fm.lng || !fm.name) continue;
    if (fm.status && fm.status !== 'published') continue;

    places.push({
      name: fm.name,
      lat: fm.lat,
      lng: fm.lng,
      type: fm.category || 'unknown',
      osmType: 'curated',
      osmId: file.replace('.md', ''),
      tags: fm,
      source: 'places',
      goodFor: fm.good_for || [],
    });
  }

  return places;
}

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

  // URL source — cache to .cache/ so we don't re-fetch every run
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const __scriptDir = new URL('.', import.meta.url).pathname;
    const cacheDir = join(__scriptDir, '.cache');
    const hash = source.replace(/[^a-zA-Z0-9]/g, '_').slice(-60);
    const cachePath = join(cacheDir, `source-${hash}.json`);

    let geojson;
    if (existsSync(cachePath)) {
      console.log(`[source] Using cached GeoJSON from ${cachePath}`);
      geojson = JSON.parse(readFileSync(cachePath, 'utf8'));
    } else {
      console.log(`[source] Fetching GeoJSON from ${source}...`);
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
      geojson = await res.json();
      writeFileSync(cachePath, JSON.stringify(geojson), 'utf8');
      console.log(`[source] Cached to ${cachePath}`);
    }
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
  const primarySegments = await loadSegments(source, bounds);
  console.log(`[pipeline] ${primarySegments.length} primary segments loaded`);

  const validSegments = primarySegments.filter(s => !s.invalida);
  console.log(`[pipeline] ${primarySegments.length - validSegments.length} invalid segments filtered`);

  // OSM is the geometry source of truth (continuously updated).
  // Catastro enriches with metadata (condition, emplazamiento, width, video)
  // where both cover the same path.
  let segments;
  if (source !== 'overpass' && bounds) {
    console.log('[pipeline] Fetching cycling ways from Overpass (primary geometry)...');
    const osmWays = await fetchCyclingWays(bounds);
    const osmSegments = osmWays.map((el, i) => parseOverpassWay(el, i));
    console.log(`[pipeline] ${osmSegments.length} OSM cycling ways fetched`);

    // For each OSM segment, find overlapping catastro and merge metadata
    let enriched = 0;
    for (const osm of osmSegments) {
      const osmCoords = osm.geometry.type === 'MultiLineString'
        ? osm.geometry.coordinates.flat() : osm.geometry.coordinates;
      const osmSample = samplePoints(osmCoords, 5);
      for (const cat of validSegments) {
        if (haversineM(osm.centroid, cat.centroid) > osm.lengthM + cat.lengthM) continue;
        const catCoords = cat.geometry.type === 'MultiLineString'
          ? cat.geometry.coordinates.flat() : cat.geometry.coordinates;
        const catSample = samplePoints(catCoords, 5);
        let near = 0;
        for (const op of osmSample) {
          for (const cp of catSample) {
            if (haversineM(op, cp) < 80) { near++; break; }
          }
        }
        if (osmSample.length > 0 && near / osmSample.length > 0.4) {
          // Merge catastro metadata onto OSM geometry
          if (cat.emplazamiento) osm.emplazamiento = cat.emplazamiento;
          if (cat.clasificacion) osm.clasificacion = cat.clasificacion;
          if (cat.score != null) osm.score = cat.score;
          if (cat.ancho_cm) osm.ancho_cm = cat.ancho_cm;
          if (cat.video) osm.video = cat.video;
          if (cat.videoId) osm.videoId = cat.videoId;
          if (cat.tipo) osm.tipo = cat.tipo;
          if (cat.comuna) osm.comuna = cat.comuna;
          enriched++;
          break; // one catastro match per OSM segment
        }
      }
    }

    // Add catastro-only segments (not covered by any OSM way)
    let catastroOnly = 0;
    for (const cat of validSegments) {
      const catCoords = cat.geometry.type === 'MultiLineString'
        ? cat.geometry.coordinates.flat() : cat.geometry.coordinates;
      const catSample = samplePoints(catCoords, 5);
      let covered = false;
      for (const osm of osmSegments) {
        if (haversineM(cat.centroid, osm.centroid) > cat.lengthM + osm.lengthM) continue;
        const osmCoords = osm.geometry.type === 'MultiLineString'
          ? osm.geometry.coordinates.flat() : osm.geometry.coordinates;
        const osmSample = samplePoints(osmCoords, 5);
        let near = 0;
        for (const cp of catSample) {
          for (const op of osmSample) {
            if (haversineM(cp, op) < 80) { near++; break; }
          }
        }
        if (catSample.length > 0 && near / catSample.length > 0.4) {
          covered = true;
          break;
        }
      }
      if (!covered) {
        osmSegments.push(cat);
        catastroOnly++;
      }
    }

    segments = osmSegments;
    console.log(`[pipeline] ${enriched} OSM segments enriched with catastro metadata`);
    console.log(`[pipeline] ${catastroOnly} catastro-only segments added`);
  } else {
    segments = validSegments;
  }
  console.log(`[pipeline] ${segments.length} total segments`);

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

  // Fetch metro stations as bailout anchors
  console.log('[pipeline] Fetching metro stations...');
  const metroStations = await fetchMetroStations(bounds);
  console.log(`[pipeline] ${metroStations.length} metro stations found`);

  // Fetch waterways for river corridor bonus
  console.log('[pipeline] Fetching waterways...');
  const waterways = await fetchWaterways(bounds);
  console.log(`[pipeline] ${waterways.length} waterways found`);

  // Fetch motorways for adjacency penalty
  console.log('[pipeline] Fetching motorways...');
  const motorways = await fetchMotorways(bounds);
  console.log(`[pipeline] ${motorways.length} motorway segments found`);

  // Fetch road network for gap routing
  console.log('[pipeline] Fetching road network...');
  const roadWays = await fetchRoadNetwork(bounds);
  console.log(`[pipeline] ${roadWays.length} road segments found`);
  const roadGraph = buildRoadGraph(roadWays);

  // Fetch zone data
  console.log('[pipeline] Fetching zone data...');
  const zonePOIs = await fetchZonePOIs(bounds);
  console.log(`[pipeline] ${zonePOIs.length} zone POIs fetched`);

  const treeRows = await fetchTreeRows(bounds);
  console.log(`[pipeline] ${treeRows.length} tree rows fetched`);

  const bikeParking = await fetchBikeParking(bounds);
  console.log(`[pipeline] ${bikeParking.length} bike parking points fetched`);

  // Detect zones
  const { zones, repulsionCells, treeCells } = detectZones({
    waterways, pois: zonePOIs, motorways,
    metroStations, bikeParking, treeRows,
    parkPOIs: [],
  });

  // Add metro stations as bailout-type POIs
  for (const station of metroStations) {
    pois.push(station);
  }

  // Load curated places from the data repo if available
  const contentDir = args['content-dir'] || '.';
  const placesDir = join(contentDir, city, 'places');
  const curatedPlaces = existsSync(placesDir) ? loadPlaces(placesDir) : [];
  if (curatedPlaces.length > 0) {
    console.log(`[pipeline] ${curatedPlaces.length} curated places loaded from ${placesDir}`);
  }

  console.log('[pipeline] Scoring anchors...');
  const rawAnchors = scoreAnchors(pois, axes, curatedPlaces);
  console.log(`[pipeline] ${rawAnchors.length} anchors scored`);

  console.log('[pipeline] Clustering destination zones...');
  const anchors = clusterDestinationZones(rawAnchors);
  const multiZones = anchors.filter((a) => a.zoneMembers > 1);
  console.log(`[pipeline] ${anchors.length} zones (${multiZones.length} with multiple POIs)`);

  // --- Pass 3: Stitch trips ---
  console.log('[pipeline] Stitching routes...');
  const routes = stitchTrips(axes, anchors, { roadGraph, zones, repulsionCells, treeCells });
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
    anchors: anchors.map((a) => ({
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
