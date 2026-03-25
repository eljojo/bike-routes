#!/usr/bin/env node
/**
 * generate-routes.mjs
 *
 * Reads a proposals JSON (from suggest-routes.mjs) and writes the
 * bike-routes directory structure:
 *
 *   {output}/config.yml
 *   {output}/tag-translations.yml
 *   {output}/routes/{slug}/main.gpx
 *   {output}/routes/{slug}/index.md
 *   {output}/routes/{slug}/media.yml
 *   {output}/places/{slug}.md
 *
 * Usage:
 *   node scripts/generate-routes.mjs --proposals santiago-proposals.json \
 *     --output santiago [--limit 50]
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { buildGPX } from './lib/gpx.mjs';
import { haversineM } from './lib/geo.mjs';
import { buildMarkdown } from './lib/markdown.mjs';
import { buildRoadGraph } from './lib/roads.mjs';
import { fetchRoadNetwork, fetchCyclingWays, fetchWaterways, fetchMotorways, fetchMetroStations, fetchZonePOIs, fetchBikeParking, fetchParkAreas } from './lib/overpass.mjs';
import { parseOverpassWay } from './lib/segments.mjs';
import { detectAxes } from './lib/axes.mjs';
import { buildSegmentGraph, buildRoute, segmentsToAxisChain } from './lib/trips.mjs';
import { detectZones } from './lib/zones.mjs';
import { buildZoneGraph, nearestSegmentToZone, aStarSegments } from './lib/zone-graph.mjs';
import { buildTemplatePath } from './lib/template-routes.mjs';
import { slugify } from './lib/slugify.mjs';
import { curateLaunchSet } from './lib/curate.mjs';
import { scoreAnchors, clusterDestinationZones } from './lib/anchors.mjs';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--proposals') args.proposals = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
    else if (argv[i] === '--limit') args.limit = parseInt(argv[++i], 10);
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args.proposals || !args.output) {
  console.error('Usage: node scripts/generate-routes.mjs --proposals <file> --output <dir> [--limit N]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Load proposals
// ---------------------------------------------------------------------------

const proposalsPath = path.resolve(args.proposals);
if (!fs.existsSync(proposalsPath)) {
  console.error(`Proposals file not found: ${proposalsPath}`);
  process.exit(1);
}

const proposals = JSON.parse(fs.readFileSync(proposalsPath, 'utf8'));
const outputDir = path.resolve(args.output);

// Apply --limit: triggers curation to select the best routes up to the limit.
// Without --limit, all routes from the proposals are used as-is.
let routes = proposals.routes;
if (args.limit && args.limit > 0) {
  routes = curateLaunchSet(proposals, { target: args.limit });
}

console.log(`Generating bike-routes for ${proposals.city}...`);

// ---------------------------------------------------------------------------
// Build road graph for gap routing in GPX
// ---------------------------------------------------------------------------

let roadGraph = null;
if (proposals.bounds) {
  console.log('Building road graph for gap routing...');
  const roadWays = await fetchRoadNetwork(proposals.bounds);
  roadGraph = buildRoadGraph(roadWays);
}

// ---------------------------------------------------------------------------
// Scan for templated routes (with waypoints: in frontmatter)
// ---------------------------------------------------------------------------

const routesDir = path.join(outputDir, 'routes');
const placesDir = path.join(outputDir, 'places');

const templatedRoutes = [];
if (fs.existsSync(routesDir)) {
  for (const slug of fs.readdirSync(routesDir)) {
    const mdPath = path.join(routesDir, slug, 'index.md');
    if (!fs.existsSync(mdPath)) continue;
    const raw = fs.readFileSync(mdPath, 'utf8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
    if (!fmMatch) continue;
    const fm = yaml.load(fmMatch[1]);
    if (!fm.waypoints || !Array.isArray(fm.waypoints)) continue;
    templatedRoutes.push({
      slug,
      frontmatter: fm,
      body: fmMatch[2] || '',
      waypoints: fm.waypoints,
    });
  }
}
if (templatedRoutes.length > 0) {
  console.log(`Found ${templatedRoutes.length} templated route(s)`);
}

const templateSlugs = new Set(templatedRoutes.map((t) => t.slug));

// ---------------------------------------------------------------------------
// Ensure output directories (clean routes, preserve config)
// ---------------------------------------------------------------------------

// Remove old routes — but preserve templated ones
if (fs.existsSync(routesDir)) {
  for (const slug of fs.readdirSync(routesDir)) {
    if (templateSlugs.has(slug)) continue; // preserve templates
    fs.rmSync(path.join(routesDir, slug), { recursive: true });
  }
  console.log(`  Cleared old routes/ (preserved ${templateSlugs.size} templates)`);
}
fs.mkdirSync(routesDir, { recursive: true });
fs.mkdirSync(placesDir, { recursive: true });

// config.yml and tag-translations.yml are NOT generated here.
// They're maintained by hand (config has url, cdn, etc.) and the
// setup-city script. Only routes and places are generated.

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const usedSlugs = new Map(); // base slug → count of times used

for (let i = 0; i < routes.length; i++) {
  const route = routes[i];
  const baseSlug = route.slug || slugify(route.name);
  const distKm = (route.totalDistanceM / 1000).toFixed(1);

  // Resolve slug conflicts by appending -2, -3, etc.
  let slug = baseSlug;
  const count = usedSlugs.get(baseSlug) || 0;
  if (count > 0) slug = `${baseSlug}-${count + 1}`;
  usedSlugs.set(baseSlug, count + 1);

  // Don't overwrite curator-templated routes
  if (templateSlugs.has(slug)) continue;

  const routeDir = path.join(outputDir, 'routes', slug);
  fs.mkdirSync(routeDir, { recursive: true });

  const { gpx, traceDistanceM } = await buildGPX(route, { roadGraph });
  // Use actual trace distance (includes road-routed gaps) instead of
  // infra+crow-flies which undercounts what the cyclist actually rides.
  route.totalDistanceM = traceDistanceM;

  fs.writeFileSync(path.join(routeDir, 'main.gpx'), gpx);
  fs.writeFileSync(path.join(routeDir, 'index.md'), buildMarkdown(route));
  fs.writeFileSync(path.join(routeDir, 'media.yml'), '[]\n');

  const actualKm = (traceDistanceM / 1000).toFixed(1);
  console.log(`  Route ${i + 1}/${routes.length}: ${slug} (${actualKm} km)`);
}

// ---------------------------------------------------------------------------
// Rebuild templated routes from current infrastructure
// ---------------------------------------------------------------------------

if (templatedRoutes.length > 0 && proposals.bounds) {
  console.log('Rebuilding templated routes from current infrastructure...');

  // Build the infrastructure needed for zone-graph routing
  console.log('  Fetching cycling ways...');
  const ways = await fetchCyclingWays(proposals.bounds);
  const segs = ways.map((el, i) => parseOverpassWay(el, i));
  const axes = detectAxes(segs);
  const graph = buildSegmentGraph(axes);

  console.log('  Detecting zones...');
  const [waterways, motorways, metro, zonePOIs, bikeParking, parkAreas] = await Promise.all([
    fetchWaterways(proposals.bounds), fetchMotorways(proposals.bounds),
    fetchMetroStations(proposals.bounds), fetchZonePOIs(proposals.bounds),
    fetchBikeParking(proposals.bounds), fetchParkAreas(proposals.bounds),
  ]);
  const { zones } = detectZones({ waterways, pois: zonePOIs, motorways, metroStations: metro, bikeParking, treeRows: [], parkAreas });

  console.log('  Building zone graph...');
  const zoneEdges = buildZoneGraph(zones, graph);

  // Build simple anchors for route building
  const anchors = (proposals.anchors || []).map(a => ({ ...a, anchorScore: a.anchorScore || 5 }));

  for (const tmpl of templatedRoutes) {
    const routeDir = path.join(outputDir, 'routes', tmpl.slug);
    fs.mkdirSync(routeDir, { recursive: true });

    // Build route from waypoints using segment-level A*
    // Pass ALL named data for waypoint matching: axes, zones, anchors, metro, zone POIs
    const allPOIs = [
      ...anchors,
      ...metro.map(s => ({ name: s.name, lat: s.lat, lng: s.lng })),
      ...zonePOIs.filter(p => p.tags?.name).map(p => ({ name: p.tags.name, lat: p.lat, lng: p.lng })),
      ...parkAreas.map(p => ({ name: p.name, lat: p.lat, lng: p.lng })),
    ];
    const result = buildTemplatePath(tmpl.waypoints, graph, axes, allPOIs, zones);

    let gpxBuilt = false;
    if (result && result.segPath.length >= 2) {
      console.log(`  ${tmpl.slug}: resolved ${result.resolvedNames.join(' → ')}`);

      const axisChain = segmentsToAxisChain(result.segPath, graph, axes);
      if (axisChain.length > 0) {
        // Find anchors near first/last segment
        const firstSeg = graph.segments[result.segPath[0]];
        const lastSeg = graph.segments[result.segPath[result.segPath.length - 1]];
        let startAnchor = null, endAnchor = null, bestSD = 5000, bestED = 5000;
        for (const a of anchors) {
          const ds = haversineM([a.lng, a.lat], firstSeg.centroid);
          const de = haversineM([a.lng, a.lat], lastSeg.centroid);
          if (ds < bestSD) { bestSD = ds; startAnchor = a; }
          if (de < bestED) { bestED = de; endAnchor = a; }
        }

        if (startAnchor && endAnchor) {
          const route = buildRoute(axisChain, startAnchor, endAnchor, anchors, { skipQualityGates: true });
          if (route) {
            const { gpx, traceDistanceM } = await buildGPX(route, { roadGraph });
            fs.writeFileSync(path.join(routeDir, 'main.gpx'), gpx);

            const fm = { ...tmpl.frontmatter };
            fm.distance_km = Math.round(traceDistanceM / 100) / 10;
            if (fm.variants && fm.variants[0]) fm.variants[0].distance_km = fm.distance_km;
            const mdContent = `---\n${yaml.dump(fm, { lineWidth: -1 })}---\n${tmpl.body}`;
            fs.writeFileSync(path.join(routeDir, 'index.md'), mdContent);
            if (!fs.existsSync(path.join(routeDir, 'media.yml'))) {
              fs.writeFileSync(path.join(routeDir, 'media.yml'), '[]\n');
            }
            gpxBuilt = true;
            console.log(`  Template rebuilt: ${tmpl.slug} (${fm.distance_km} km)`);
          } else {
            console.log(`  ${tmpl.slug}: buildRoute rejected the path`);
          }
        }
      }
    }

    if (!gpxBuilt) {
      const fm = { ...tmpl.frontmatter };
      const mdContent = `---\n${yaml.dump(fm, { lineWidth: -1 })}---\n${tmpl.body}`;
      fs.writeFileSync(path.join(routeDir, 'index.md'), mdContent);
      if (!fs.existsSync(path.join(routeDir, 'media.yml'))) {
        fs.writeFileSync(path.join(routeDir, 'media.yml'), '[]\n');
      }
      console.log(`  Template preserved (no GPX): ${tmpl.slug}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Places — deduplicated anchor POIs
// ---------------------------------------------------------------------------

// Category mapping from POI type → app place category.
// Keys must match categoryEmoji in src/lib/geo/place-categories.ts
const TYPE_TO_CATEGORY = {
  park: 'park',
  parque: 'park',
  garden: 'park',
  square: 'park',       // plazas in Chile are green spaces
  beach: 'beach',
  viewpoint: 'lookout',
  museum: 'something-interesting',
  bridge: 'bridge',
  water: 'chill-spot',
  marketplace: 'restaurant',
  cafe: 'cafe',
  ice_cream: 'ice-cream',
  pub: 'beer',
  station: 'meeting-point',
  bicycle_rental: 'bike-rental',
  bicycle: 'bike-shop',
  camp_site: 'camping-spot',
  ferry_terminal: 'ferry',
  curated: 'park',
};

// Collect all start/end anchors from selected routes, dedup by name
const placesMap = new Map();

for (const route of routes) {
  for (const anchor of [route.startAnchor, route.endAnchor]) {
    if (!anchor || placesMap.has(anchor.name)) continue;

    // Type comes from the route anchor (set by trips.mjs from scored anchors)
    // But OSM types are often wrong (plazas tagged as parks). Name is more reliable
    // for distinguishing parks from plazas.
    const category = inferCategoryFromName(anchor.name) || TYPE_TO_CATEGORY[anchor.type] || 'park';

    placesMap.set(anchor.name, {
      name: anchor.name,
      lat: anchor.lat,
      lng: anchor.lng,
      category,
    });
  }
}

/** Infer category from place name. Returns null if no strong signal. */
function inferCategoryFromName(name) {
  const lower = name.toLowerCase();
  if (lower.includes('parque')) return 'park';
  if (lower.includes('plaza') || lower.includes('plazoleta')) return 'park';
  if (lower.includes('mercado')) return 'restaurant';
  if (lower.includes('museo')) return 'something-interesting';
  if (lower.includes('río') || lower.includes('lago')) return 'chill-spot';
  if (lower.includes('cerro') || lower.includes('mirador')) return 'lookout';
  return null;
}

let placesWritten = 0;
let placesSkipped = 0;
for (const place of placesMap.values()) {
  const slug = slugify(place.name);
  const placePath = path.join(outputDir, 'places', `${slug}.md`);

  // Don't overwrite hand-curated places
  if (fs.existsSync(placePath)) {
    placesSkipped++;
    continue;
  }

  const content = `---
name: "${place.name.replace(/"/g, '\\"')}"
category: ${place.category}
lat: ${place.lat}
lng: ${place.lng}
status: published
good_for:
  - destination
---
`;
  fs.writeFileSync(placePath, content);
  placesWritten++;
}

console.log(`  ${placesWritten} places generated${placesSkipped > 0 ? `, ${placesSkipped} existing kept` : ''}`);
console.log(`Done! ${routes.length} routes in ${args.output}/`);
