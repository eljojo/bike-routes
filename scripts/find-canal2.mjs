import { queryOverpass } from './lib/overpass.mjs';

// Search for cycleways near Canal San Carlos (-33.433, -70.5725)
const q = `[out:json][timeout:60];
(
  way["highway"="cycleway"](-33.45,-70.59,-33.42,-70.55);
);
out tags;`;
const data = await queryOverpass(q);
for (const el of data.elements) {
  console.log(el.type + ' ' + el.id + ': ' + (el.tags?.name || '(unnamed)') + ' hw=' + el.tags?.highway);
}
console.log(data.elements.length + ' cycleways found');
