import { haversineM } from './geo.mjs';

/**
 * Score a single way's relaxation level (0-5).
 *
 * 5 = full relaxation (park path, dedicated cycleway, physical separation)
 * 4 = comfortable (median path, designated bike path)
 * 3 = aware (sidewalk-level separation, shared path)
 * 2 = alert (quiet street with bike lane)
 * 1 = tense (painted lane on moderate road)
 * 0 = stressed (no bike infrastructure, busy road)
 *
 * Catastro data overrides OSM baseline when available.
 *
 * @param {Object} tags - OSM tags from the way
 * @param {Object} [catastro] - catastro segment data { emplazamiento, quality, ... }
 * @returns {number} 0-5
 */
export function relaxationScore(tags, catastro) {
  // Catastro overrides when available
  if (catastro?.emplazamiento) {
    const emp = catastro.emplazamiento;
    if (emp === 'parque') return 5;
    if (emp === 'bandejón') return 5;
    if (emp === 'mediana') return 4;
    if (emp === 'acera') return 3;
    if (emp === 'calzada') return 0;
  }

  // OSM tag baseline
  const hw = tags.highway || '';
  const cw = tags.cycleway || '';

  // Dedicated cycleway — headphones on
  if (hw === 'cycleway') return 5;
  if (cw === 'track' || cw === 'separate') return 5;

  // Designated bike path
  if (hw === 'path' && tags.bicycle === 'designated') return 4;
  if (hw === 'path' && tags.bicycle === 'yes') return 4;

  // Shared path / footway with bike access
  if (hw === 'footway' && tags.bicycle === 'yes') return 3;
  if (hw === 'path') return 3;

  // Bike lane on quiet street
  if ((hw === 'residential' || hw === 'living_street') && cw) return 2;

  // Bike lane on busier road
  if (cw === 'lane') return 1;
  if (cw === 'shared_lane') return 1;

  // No bike infrastructure
  return 0;
}

function wayLengthM(way) {
  let len = 0;
  for (let i = 1; i < way.geometry.length; i++) {
    len += haversineM(
      [way.geometry[i - 1].lon, way.geometry[i - 1].lat],
      [way.geometry[i].lon, way.geometry[i].lat],
    );
  }
  return len;
}

/**
 * Score a complete candidate route.
 *
 * @param {Array<{id: number, geometry: Array<{lon: number, lat: number}>, tags: Object}>} ways - ordered ways
 * @param {[number,number]} startCoord - [lng, lat]
 * @param {[number,number]} endCoord - [lng, lat]
 * @param {Object} [options]
 * @param {Array} [options.places] - nearby places for amenity scoring
 * @param {Map} [options.catastroByWayId] - catastro data keyed by OSM way id
 * @returns {{ relaxation: number, directness: number, transitions: number, coverage: number, amenities: number, total: number }}
 */
export function scoreRoute(ways, startCoord, endCoord, options = {}) {
  const { places = [], catastroByWayId = new Map() } = options;

  // Relaxation (0-10): length-weighted average, scaled from 0-5 to 0-10
  let totalLen = 0;
  let weightedRelax = 0;
  const perWayScores = [];
  for (const w of ways) {
    const len = wayLengthM(w);
    const catastro = catastroByWayId.get(w.id);
    const r = relaxationScore(w.tags || {}, catastro);
    weightedRelax += r * len;
    totalLen += len;
    perWayScores.push(r);
  }
  const relaxation = totalLen > 0 ? (weightedRelax / totalLen) * 2 : 0;

  // Directness (0-5): route length vs straight-line distance
  const straightLine = haversineM(startCoord, endCoord);
  const ratio = straightLine > 0 ? totalLen / straightLine : 10;
  const directness = ratio <= 1.2 ? 5 : ratio <= 1.5 ? 4 : ratio <= 2.0 ? 3 : ratio <= 3.0 ? 1 : 0;

  // Transitions (-3 to 0): penalty for big drops in relaxation level
  let transitions = 0;
  for (let i = 1; i < perWayScores.length; i++) {
    const drop = perWayScores[i - 1] - perWayScores[i];
    if (drop >= 3) transitions -= 1.5;
    else if (drop >= 2) transitions -= 0.5;
  }
  transitions = Math.max(-3, transitions);

  // Coverage (0-2): fraction on known bike infrastructure
  const infraLen = ways.reduce((s, w) => s + (relaxationScore(w.tags || {}) > 0 ? wayLengthM(w) : 0), 0);
  const coverage = totalLen > 0 ? Math.min((infraLen / totalLen) * 2, 2) : 0;

  // Amenities (0-3): diversity of nearby place types
  let amenities = 0;
  if (places.length > 0) {
    const types = new Set();
    for (const place of places) {
      const pc = [place.lng, place.lat];
      for (const w of ways) {
        for (const p of w.geometry) {
          if (haversineM(pc, [p.lon, p.lat]) < 300) {
            types.add(place.category || 'other');
            break;
          }
        }
      }
    }
    amenities = Math.min(types.size, 3);
  }

  const total = relaxation + directness + transitions + coverage + amenities;
  return { relaxation, directness, transitions, coverage, amenities, total };
}
