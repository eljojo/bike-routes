/**
 * City adapter — region-specific configuration for build-bikepaths and other scripts.
 *
 * Each city exports:
 *   - relationNamePattern: regex string for OSM relation name matching
 *   - namedWayQueries(bbox): array of { label, q } Overpass queries for named ways
 *   - externalData: optional external data source config (e.g. catastro)
 *
 * Add new cities by adding a case to the switch below.
 */

// ---------------------------------------------------------------------------
// Santiago
// ---------------------------------------------------------------------------

const santiago = {
  relationNamePattern: '[Cc]iclo|[Bb]ici|[Pp]ista [Rr]ecreativa|[Pp]arque',

  namedWayQueries: (bbox) => [
    { label: 'cycleways', q: `[out:json][timeout:60];way["highway"="cycleway"]["name"](${bbox});out tags center;` },
    { label: 'bike paths', q: `[out:json][timeout:60];way["highway"="path"]["bicycle"~"designated|yes"]["name"](${bbox});out tags center;` },
    { label: 'bike lanes', q: `[out:json][timeout:60];way["cycleway"~"lane|track"]["name"](${bbox});out tags center;` },
    { label: 'bike lanes (left)', q: `[out:json][timeout:60];way["cycleway:left"~"lane|track"]["name"](${bbox});out tags center;` },
    { label: 'bike lanes (right)', q: `[out:json][timeout:60];way["cycleway:right"~"lane|track"]["name"](${bbox});out tags center;` },
    { label: 'bike lanes (both)', q: `[out:json][timeout:60];way["cycleway:both"~"lane|track"]["name"](${bbox});out tags center;` },
    { label: 'linear parks', q: `[out:json][timeout:60];way["leisure"="park"]["name"~"[Pp]arque.*[Cc]anal|[Pp]arque.*[Ll]ineal|[Pp]arque.*[Bb]ici"](${bbox});out tags center;` },
    { label: 'pistas recreativas', q: `[out:json][timeout:60];way["name"~"[Pp]ista [Rr]ecreativa"](${bbox});out tags center;` },
  ],

  externalData: {
    type: 'catastro',
    url: 'https://raw.githubusercontent.com/pedaleable/mapa-catastro/refs/heads/gh-pages/datos/catastro.geojson',
  },
};

// ---------------------------------------------------------------------------
// Ottawa
// ---------------------------------------------------------------------------

const ottawa = {
  // NCC pathways, recreational trails, cycling routes (English + French)
  relationNamePattern: '[Pp]athway|[Tt]rail|[Cc]ycl|[Bb]ike|[Ss]entier|MUP|[Pp]iste',

  namedWayQueries: (bbox) => [
    { label: 'cycleways', q: `[out:json][timeout:60];way["highway"="cycleway"]["name"](${bbox});out tags center;` },
    { label: 'bike paths', q: `[out:json][timeout:60];way["highway"="path"]["bicycle"~"designated|yes"]["name"](${bbox});out tags center;` },
    { label: 'bike lanes', q: `[out:json][timeout:60];way["cycleway"~"lane|track"]["name"](${bbox});out tags center;` },
    { label: 'bike lanes (left)', q: `[out:json][timeout:60];way["cycleway:left"~"lane|track"]["name"](${bbox});out tags center;` },
    { label: 'bike lanes (right)', q: `[out:json][timeout:60];way["cycleway:right"~"lane|track"]["name"](${bbox});out tags center;` },
    { label: 'bike lanes (both)', q: `[out:json][timeout:60];way["cycleway:both"~"lane|track"]["name"](${bbox});out tags center;` },
    // Multi-use paths designated for cycling (NCC pathways, recreational paths)
    { label: 'multi-use paths', q: `[out:json][timeout:60];way["highway"="path"]["bicycle"~"designated|yes"]["name"](${bbox});out tags center;` },
    // Footways designated for cycling (shared MUPs tagged as footway)
    { label: 'shared footways', q: `[out:json][timeout:60];way["highway"="footway"]["bicycle"~"designated|yes"]["name"](${bbox});out tags center;` },
  ],

  externalData: null,
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const adapters = { santiago, ottawa };

export function loadCityAdapter(cityName) {
  const adapter = adapters[cityName];
  if (!adapter) {
    const available = Object.keys(adapters).join(', ');
    throw new Error(`No city adapter for "${cityName}". Available: ${available}`);
  }
  return adapter;
}
