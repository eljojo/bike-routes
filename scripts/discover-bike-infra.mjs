import { queryOverpass } from './lib/overpass.mjs';
import { readFileSync } from 'fs';
import yaml from 'js-yaml';

// Santiago bounding box (wide)
const bbox = '-33.65,-70.85,-33.30,-70.45';

// Find all cycling-related relations
const q = `[out:json][timeout:120];
(
  relation["route"="bicycle"](${bbox});
  relation["type"="route"]["name"~"[Cc]iclo|[Bb]ike|[Bb]ici"](${bbox});
  relation["type"="route"]["name"~"[Pp]arque|[Pp]ista"](${bbox});
);
out tags;`;

console.log('Searching OSM for cycling relations in Santiago...');
const data = await queryOverpass(q);

// Load existing bikepaths.yml to find what we're missing
const bp = yaml.load(readFileSync('../santiago/bikepaths.yml', 'utf8'));
const existingRelations = new Set();
for (const p of bp.bike_paths) {
  if (p.osm_relations) for (const r of p.osm_relations) existingRelations.add(r);
}

console.log('\nFound ' + data.elements.length + ' cycling relations in OSM');
console.log('Already in bikepaths.yml: ' + existingRelations.size + ' relations\n');

const missing = [];
const existing = [];
for (const el of data.elements) {
  const name = el.tags?.name || '(unnamed)';
  const type = el.tags?.route || el.tags?.type || '-';
  if (existingRelations.has(el.id)) {
    existing.push({ id: el.id, name, type });
  } else {
    missing.push({ id: el.id, name, type });
  }
}

console.log('MISSING from bikepaths.yml (' + missing.length + '):');
for (const m of missing) {
  console.log('  relation ' + m.id + ': ' + m.name + ' (' + m.type + ')');
}

console.log('\nAlready tracked (' + existing.length + '):');
for (const e of existing) {
  console.log('  relation ' + e.id + ': ' + e.name);
}
