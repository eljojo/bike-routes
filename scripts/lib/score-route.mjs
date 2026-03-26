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
  // Check both undirected and directional cycleway tags
  const cw = tags.cycleway || tags['cycleway:left'] || tags['cycleway:right'] || tags['cycleway:both'] || '';

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

  // Directness (0-5): how well does this path cover the gap?
  // Penalize both detours (path much longer than gap) AND undershoot (path much shorter).
  // A path should roughly match the gap distance.
  const straightLine = haversineM(startCoord, endCoord);
  let directness = 0;
  if (straightLine > 0) {
    const ratio = totalLen / straightLine;
    // ratio ~1.0 = perfect match. >2.0 = detour. <0.3 = way too short.
    if (ratio >= 0.5 && ratio <= 1.5) directness = 5;
    else if (ratio >= 0.3 && ratio <= 2.0) directness = 3;
    else if (ratio >= 0.2 && ratio <= 3.0) directness = 1;
    else directness = 0;
  }

  // Alignment (0-10): does the path actually bridge from → to?
  // Find closest point on path to each endpoint. A well-aligned path
  // gets close to both from AND to. A perpendicular path only gets
  // close to the corridor midpoint.
  // Scaled 0-10 (same weight as relaxation) because alignment is the
  // primary signal for gap-filling — a perfectly relaxing path that
  // doesn't cover the corridor is useless.
  let alignment = 0;
  if (straightLine > 0) {
    let fromDist = Infinity, toDist = Infinity;
    for (const w of ways) {
      for (const p of w.geometry) {
        const c = [p.lon, p.lat];
        const df = haversineM(startCoord, c);
        const dt = haversineM(endCoord, c);
        if (df < fromDist) fromDist = df;
        if (dt < toDist) toDist = dt;
      }
    }
    // Perfect alignment: both distances are 0 → score 10
    // Score decreases as the sum of distances grows relative to the gap
    const approachRatio = (fromDist + toDist) / straightLine;
    if (approachRatio <= 0.3) alignment = 10;
    else if (approachRatio <= 0.6) alignment = 8;
    else if (approachRatio <= 1.0) alignment = 6;
    else if (approachRatio <= 1.5) alignment = 4;
    else if (approachRatio <= 2.0) alignment = 2;
    else alignment = 0;
  }

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

  // Alignment gates the total: a perfectly comfortable path that doesn't
  // cover the corridor is useless for gap-filling. Apply alignment as a
  // multiplier (0.0–1.0) on the comfort components so that only paths
  // that actually bridge the gap can score highly.
  // Transitions penalty is also gated: a well-aligned path with mixed
  // infrastructure is still better than a comfortable path off-corridor.
  const alignFactor = alignment / 10;  // 0.0–1.0
  const gatedRelaxation = relaxation * alignFactor;
  const gatedCoverage = coverage * alignFactor;
  const gatedTransitions = transitions * (1 - alignFactor);  // high alignment dampens penalty

  const total = gatedRelaxation + directness + alignment + gatedTransitions + gatedCoverage + amenities;
  return { relaxation, directness, alignment, transitions, coverage, amenities, total };
}
