/**
 * Pass 2 — Anchor scoring.
 *
 * Scores POIs by anchor quality and filters to those near bike infrastructure.
 */

import { haversineM } from './geo.mjs';

/** Base anchor scores by OSM type value. */
const ANCHOR_SCORES = {
  park: 8,
  square: 7,
  marketplace: 7,
  station: 7,
  museum: 6,
  viewpoint: 6,
  water: 5,
  bicycle_rental: 4,
  garden: 4,
  cafe: 2,
};

const MAX_INFRA_DIST_M = 500;
const PROXIMITY_BONUS_CLOSE_M = 100;
const PROXIMITY_BONUS_NEAR_M = 300;
const DEDUP_RADIUS_M = 200;

/**
 * Collect all representative points from axes:
 * start, end, and centroid of every segment in every axis.
 * Returns array of [lng, lat] pairs.
 */
function infraPoints(axes) {
  const points = [];
  for (const axis of axes) {
    for (const seg of axis.segments) {
      if (seg.start) points.push(seg.start);   // [lng, lat]
      if (seg.end) points.push(seg.end);         // [lng, lat]
      if (seg.centroid) points.push(seg.centroid); // [lng, lat]
    }
  }
  return points;
}

/**
 * Score POIs by anchor quality, filtered to those within 500m of bike infrastructure.
 *
 * @param {Array<{ name, lat, lng, type, osmType, osmId, tags }>} pois
 * @param {Array} axes - output of detectAxes()
 * @returns {Array<{ ...poi, anchorScore, distToInfraM }>} sorted by anchorScore desc
 */
export function scoreAnchors(pois, axes) {
  const points = infraPoints(axes);

  if (points.length === 0) {
    console.warn('[anchors] No infrastructure points found — returning empty anchor list');
    return [];
  }

  // Score and filter each POI
  const scored = [];
  for (const poi of pois) {
    const poiCoord = [poi.lng, poi.lat]; // [lng, lat] for haversineM

    // Find minimum distance to any infrastructure point
    let minDist = Infinity;
    for (const pt of points) {
      const d = haversineM(poiCoord, pt);
      if (d < minDist) minDist = d;
    }

    if (minDist > MAX_INFRA_DIST_M) continue;

    const baseScore = ANCHOR_SCORES[poi.type] ?? 1;

    let bonus = 0;
    if (minDist < PROXIMITY_BONUS_CLOSE_M) bonus = 2;
    else if (minDist < PROXIMITY_BONUS_NEAR_M) bonus = 1;

    scored.push({
      ...poi,
      anchorScore: baseScore + bonus,
      distToInfraM: Math.round(minDist),
    });
  }

  // Deduplicate: same name (case-insensitive) within 200m — keep higher scored
  const deduped = [];
  const used = new Set();

  // Sort by score desc so we always keep the best one first
  scored.sort((a, b) => b.anchorScore - a.anchorScore);

  for (let i = 0; i < scored.length; i++) {
    if (used.has(i)) continue;
    const a = scored[i];
    deduped.push(a);

    for (let j = i + 1; j < scored.length; j++) {
      if (used.has(j)) continue;
      const b = scored[j];
      if (
        a.name.toLowerCase() === b.name.toLowerCase() &&
        haversineM([a.lng, a.lat], [b.lng, b.lat]) <= DEDUP_RADIUS_M
      ) {
        used.add(j);
      }
    }
  }

  // Already sorted by anchorScore desc (from the sort above before dedup)
  return deduped;
}
