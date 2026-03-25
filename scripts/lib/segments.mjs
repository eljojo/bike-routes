/**
 * Segment parsers for two data sources:
 *   - Pedaleable's catastro GeoJSON (parseCatastroFeature)
 *   - Overpass API way elements (parseOverpassWay)
 */

import { endpoints, lineLength, centroid, bearing, orientation } from './geo.mjs';

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

const STRIP_PREFIXES = /^(AV\.|AVENIDA|CALLE|PASEO|CICLOVIA|CICLOVÍA|CICLOBANDA|SENDERO)\s+/;

/**
 * Normalise a segment name for comparison:
 * uppercase, strip accents, trim, remove common street/bike prefixes, collapse spaces.
 *
 * "Ciclovía Vicuña Mackenna", "Avenida Vicuña Mackenna", and "VICUNA MACKENNA"
 * all normalize to "VICUNA MACKENNA" so they group into one corridor.
 */
export function normalizeName(name) {
  if (!name) return '';
  return name
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(STRIP_PREFIXES, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Catastro parser
// ---------------------------------------------------------------------------

/**
 * Parse a GeoJSON feature from Pedaleable's catastro into a normalised segment.
 *
 * Expected feature.properties keys:
 *   nombre, _comuna, km, _tipo, _emplazamiento, _ancho_cm,
 *   _eval_graduada_pedal_clasif, _eval_graduada_pedal, _inválida, video, video_id
 *
 * The geometry must be a MultiLineString (as supplied by the catastro source).
 */
export function parseCatastroFeature(feature, index) {
  const p = feature.properties;
  const geo = feature.geometry;
  const ep = endpoints(geo);

  const nombre = p.nombre || `unnamed-${index}`;

  return {
    index,
    source: 'catastro',
    nombre,
    normalizedName: normalizeName(nombre),
    comuna: (p._comuna || 'unknown').toLowerCase().trim(),
    km: p.km || 0,
    lengthM: lineLength(geo),
    tipo: p._tipo || null,
    emplazamiento: p._emplazamiento || null,
    ancho_cm: p._ancho_cm || null,
    surface: null,
    lit: false,
    maxspeed: null,
    lanes: null,
    segregated: false,
    smoothness: null,
    incline: null,
    clasificacion: p._eval_graduada_pedal_clasif || null,
    score: p._eval_graduada_pedal || null,
    invalida: p['_inválida'] === '1',
    video: p.video || null,
    videoId: p.video_id || null,
    start: ep.start,
    end: ep.end,
    centroid: centroid(geo),
    bearing: bearing(geo),
    orientation: orientation(geo),
    geometry: geo,
  };
}

// ---------------------------------------------------------------------------
// Overpass parser
// ---------------------------------------------------------------------------

/**
 * Parse an Overpass way element into the same normalised segment shape.
 *
 * element.geometry is an array of { lat, lon } objects (Overpass JSON format).
 * element.tags contains OSM tags.
 */
export function parseOverpassWay(element, index) {
  // Convert Overpass geometry to GeoJSON LineString ([lng, lat] order)
  const coordinates = element.geometry.map(({ lat, lon }) => [lon, lat]);
  const geo = { type: 'LineString', coordinates };

  const tags = element.tags || {};
  // Use name if available; unnamed cycleways stay unnamed (will be
  // handled as individual axes and merged by geometric continuity)
  const nombre = tags.name || tags['name:es'] || '';
  const tipo = tags.cycleway || tags.highway || null;

  // Overpass width tags are in metres; convert to cm to match catastro units
  let ancho_cm = null;
  if (tags.width) {
    const w = parseFloat(tags.width);
    if (!Number.isNaN(w)) ancho_cm = Math.round(w * 100);
  }

  const surface = tags.surface || null;
  const lit = tags.lit === 'yes';

  // Additional OSM tags for stress scoring
  const maxspeed = tags.maxspeed ? parseInt(tags.maxspeed, 10) : null;
  const lanes = tags.lanes ? parseInt(tags.lanes, 10) : null;
  const segregated = tags.segregated === 'yes';
  const smoothness = tags.smoothness || null;
  const incline = tags.incline || null;

  // Infer emplazamiento from OSM tags and name — this drives the greenery
  // scoring. A cycleway through Parque Metropolitano should score as 'parque'.
  let emplazamiento = null;
  if ((tags.highway === 'path' || tags.highway === 'footway') &&
      (tags.leisure === 'park' || tags.landuse === 'recreation_ground' ||
       tags.route === 'mtb' || tags.sac_scale)) {
    emplazamiento = 'parque';
  } else if (nombre.toLowerCase().includes('parque') || nombre.toLowerCase().includes('sendero')) {
    emplazamiento = 'parque';
  }

  const ep = endpoints(geo);

  return {
    index,
    source: 'overpass',
    nombre,
    normalizedName: normalizeName(nombre),
    comuna: null,
    km: null,
    lengthM: lineLength(geo),
    tipo,
    emplazamiento,
    ancho_cm,
    surface,
    lit,
    maxspeed,
    lanes,
    segregated,
    smoothness,
    incline,
    clasificacion: null,
    score: null,
    invalida: false,
    video: null,
    videoId: null,
    start: ep.start,
    end: ep.end,
    centroid: centroid(geo),
    bearing: bearing(geo),
    orientation: orientation(geo),
    geometry: geo,
  };
}
