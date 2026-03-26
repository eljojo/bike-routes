/**
 * Fetch OSM ways and save as test fixture JSON.
 *
 * Usage:
 *   node scripts/fetch-fixture.mjs <relation-id> <output-file>
 *   node scripts/fetch-fixture.mjs --name "<osm-name>" <south>,<west>,<north>,<east> <output-file>
 */

import { writeFileSync } from 'node:fs';
import { queryOverpass } from './lib/overpass.mjs';

const args = process.argv.slice(2);

let ways;

if (args[0] === '--name') {
  const name = args[1];
  const [south, west, north, east] = args[2].split(',').map(Number);
  const outputFile = args[3];

  if (!name || !outputFile || [south, west, north, east].some(isNaN)) {
    console.error('Usage: node scripts/fetch-fixture.mjs --name "<osm-name>" <south>,<west>,<north>,<east> <output-file>');
    process.exit(1);
  }

  const query = `[out:json][timeout:60];\nway["name"="${name}"](${south},${west},${north},${east});\nout geom;`;
  console.log(`Fetching ways named "${name}" in bbox ${south},${west},${north},${east}`);
  const data = await queryOverpass(query);

  ways = (data.elements ?? [])
    .filter((el) => Array.isArray(el.geometry) && el.geometry.length >= 2)
    .map((el) => ({ id: el.id, geometry: el.geometry, tags: el.tags ?? {} }));

  console.log(`${ways.length} ways with geometry >= 2 nodes`);
  writeFileSync(outputFile, JSON.stringify(ways));
  console.log(`Saved to ${outputFile}`);
} else {
  const relationId = args[0];
  const outputFile = args[1];

  if (!relationId || !outputFile) {
    console.error('Usage: node scripts/fetch-fixture.mjs <relation-id> <output-file>');
    process.exit(1);
  }

  const query = `[out:json][timeout:60];\nrelation(${relationId});\nway(r);\nout geom;`;
  console.log(`Fetching ways from relation ${relationId}`);
  const data = await queryOverpass(query);

  ways = (data.elements ?? [])
    .filter((el) => Array.isArray(el.geometry) && el.geometry.length >= 2)
    .map((el) => ({ id: el.id, geometry: el.geometry, tags: el.tags ?? {} }));

  console.log(`${ways.length} ways with geometry >= 2 nodes`);
  writeFileSync(outputFile, JSON.stringify(ways));
  console.log(`Saved to ${outputFile}`);
}
