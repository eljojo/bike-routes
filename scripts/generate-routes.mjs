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
import { buildGPX } from './lib/gpx.mjs';
import { buildMarkdown } from './lib/markdown.mjs';
import { slugify } from './lib/slugify.mjs';
import { curateLaunchSet } from './lib/curate.mjs';

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
// Ensure output directories (clean routes, preserve config)
// ---------------------------------------------------------------------------

const routesDir = path.join(outputDir, 'routes');
const placesDir = path.join(outputDir, 'places');

// Remove old routes — regeneration replaces them completely
if (fs.existsSync(routesDir)) {
  fs.rmSync(routesDir, { recursive: true });
  console.log('  Cleared old routes/');
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

  const routeDir = path.join(outputDir, 'routes', slug);
  fs.mkdirSync(routeDir, { recursive: true });

  fs.writeFileSync(path.join(routeDir, 'main.gpx'), buildGPX(route));
  fs.writeFileSync(path.join(routeDir, 'index.md'), buildMarkdown(route));
  fs.writeFileSync(path.join(routeDir, 'media.yml'), '[]\n');

  console.log(`  Route ${i + 1}/${routes.length}: ${slug} (${distKm} km)`);
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
