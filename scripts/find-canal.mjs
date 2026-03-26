import { queryOverpass } from './lib/overpass.mjs';

const q = `[out:json][timeout:60];
(
  way["name"~"Canal San Carlos",i]["highway"](-33.46,-70.60,-33.42,-70.55);
  way["name"~"Parque Canal",i]["highway"](-33.46,-70.60,-33.42,-70.55);
  way["name"~"Parque Canal",i]["leisure"](-33.46,-70.60,-33.42,-70.55);
  relation["name"~"Canal San Carlos",i](-33.46,-70.60,-33.42,-70.55);
  relation["name"~"Parque Canal",i](-33.46,-70.60,-33.42,-70.55);
);
out tags;`;
const data = await queryOverpass(q);
for (const el of data.elements) {
  console.log(el.type + ' ' + el.id + ': ' + (el.tags?.name || '-') + ' (' + (el.tags?.highway || el.tags?.leisure || el.tags?.type || '-') + ')');
}
if (data.elements.length === 0) console.log('No results found');
