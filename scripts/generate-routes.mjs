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
// Ensure output directories
// ---------------------------------------------------------------------------

fs.mkdirSync(path.join(outputDir, 'routes'), { recursive: true });
fs.mkdirSync(path.join(outputDir, 'places'), { recursive: true });

// ---------------------------------------------------------------------------
// config.yml
// ---------------------------------------------------------------------------

const cityName = proposals.city;

const configYml = `---
name: ${cityName}
display_name: Santiago en Bici
tagline: Ciclovías y rutas para pedalear en Santiago
description: >-
  Guía de rutas y ciclovías en Santiago de Chile. Datos reales de
  infraestructura, condición y conectividad de la red ciclista,
  documentados por Corporación Pedaleable.
domain: santiago.whereto.bike
timezone: America/Santiago
locale: es-CL
locales: [es-CL]
author:
  name: Pedaleable
  email: contacto@pedaleable.org
  url: https://www.pedaleable.org
  twitter: "@pedaleable"
  photo_url: ""
center:
  lat: -33.45
  lng: -70.65
bounds:
  north: -33.30
  south: -33.65
  east: -70.45
  west: -70.85
place_categories:
  aventura:
    - parque
    - cerro
    - mirador
    - río
    - plaza
  comida:
    - café
    - restaurant
    - panadería
    - fuente-de-soda
    - heladería
  utilidad:
    - taller-de-bicicletas
    - estacionamiento-bici
    - agua
    - metro
    - bicicletero
`;

fs.writeFileSync(path.join(outputDir, 'config.yml'), configYml);
console.log('  config.yml');

// ---------------------------------------------------------------------------
// tag-translations.yml
// ---------------------------------------------------------------------------

// Collect unique comunas from the selected routes
const allComunas = new Set();
for (const route of routes) {
  for (const axis of route.axes) {
    for (const comuna of (axis.comunas || [])) {
      if (comuna) allComunas.add(comuna.toLowerCase().trim());
    }
  }
}

/**
 * Capitalize each word of a string, with special handling for common
 * Spanish prepositions/articles that should stay lowercase mid-phrase.
 */
function titleCaseEs(str) {
  const lower = ['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'o', 'u'];
  return str
    .split(' ')
    .map((word, i) => {
      if (i > 0 && lower.includes(word.toLowerCase())) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

// Build comuna translation lines
const comunaLines = [];
for (const comuna of [...allComunas].sort()) {
  // Special case: "santiago" → "Santiago Centro"
  const display = comuna === 'santiago' ? 'Santiago Centro' : titleCaseEs(comuna);
  comunaLines.push(`${comuna}:\n  es: ${display}`);
}

const tagTranslationsYml = `---
# Semantic tags (English keys → Spanish display)
bike path:
  es: ciclovía
road:
  es: calle
gravel:
  es: ripio
single track:
  es: sendero
easy:
  es: fácil
family friendly:
  es: familiar
chill:
  es: relajado
hard:
  es: difícil
elevation:
  es: desnivel
flat:
  es: plano
scenic:
  es: panorámico
snacks:
  es: comer algo
# Infrastructure tags
protected lane:
  es: ciclovía segregada
painted lane:
  es: ciclobanda
park path:
  es: sendero en parque
median lane:
  es: en mediana
commute:
  es: para ir al trabajo
# Comunas
${comunaLines.join('\n')}
`;

fs.writeFileSync(path.join(outputDir, 'tag-translations.yml'), tagTranslationsYml);
console.log('  tag-translations.yml');

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

// Category mapping from Overpass POI type
const TYPE_TO_CATEGORY = {
  park: 'parque',
  square: 'plaza',
  marketplace: 'restaurant',
  station: 'metro',
  museum: 'mirador',
  viewpoint: 'mirador',
  water: 'río',
  bicycle_rental: 'bicicletero',
  garden: 'parque',
  cafe: 'café',
};

// Build a lookup map from the proposals.anchors array
const anchorsByName = new Map();
for (const anchor of (proposals.anchors || [])) {
  anchorsByName.set(anchor.name, anchor);
}

// Collect all start/end anchors from selected routes, dedup by name
const placesMap = new Map(); // name → anchor data

for (const route of routes) {
  for (const anchor of [route.startAnchor, route.endAnchor]) {
    if (!anchor || placesMap.has(anchor.name)) continue;

    // Look up type from proposals.anchors
    const anchorData = anchorsByName.get(anchor.name);
    const type = anchorData ? anchorData.type : null;
    const category = TYPE_TO_CATEGORY[type] || 'parque';

    placesMap.set(anchor.name, {
      name: anchor.name,
      lat: anchor.lat,
      lng: anchor.lng,
      category,
    });
  }
}

let placesWritten = 0;
for (const place of placesMap.values()) {
  const slug = slugify(place.name);
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
  fs.writeFileSync(path.join(outputDir, 'places', `${slug}.md`), content);
  placesWritten++;
}

console.log(`  ${placesWritten} places generated`);
console.log(`Done! ${routes.length} routes in ${args.output}/`);
