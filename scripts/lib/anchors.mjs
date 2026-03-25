/**
 * Pass 2 — Anchor scoring.
 *
 * Scores POIs by anchor quality and filters to those near bike infrastructure.
 */

import { haversineM } from './geo.mjs';

/**
 * Base anchor scores by OSM type value.
 * Higher = better ride destination. Tuned to match what curated Ottawa
 * places look like: beaches, lookouts, and parks are where rides go;
 * cafes and bike shops are where you stop along the way.
 */
const ANCHOR_SCORES = {
  // Primary destinations — rides go HERE
  // Greenery and water pull hardest: these are where the good rides are
  beach: 9,
  park: 9,
  garden: 8,
  water: 8,        // rivers, lakes — ride along them
  bridge: 7,       // river crossings are fun landmarks
  viewpoint: 8,
  camp_site: 7,
  square: 7,
  marketplace: 7,
  station: 6,
  museum: 6,
  ferry_terminal: 6,
  // Stops along the way — not destinations, but nice to pass
  bicycle_rental: 4,
  bicycle: 4,     // shop=bicycle (bike shops)
  ice_cream: 3,
  pub: 3,
  cafe: 2,
  // Curated places from data repo get a bonus (see below)
  curated: 10,
};

// A destination 2km past the bike path endpoint is still a great ride goal.
// The old 500m filter killed places like Britannia Beach and Petrie Island.
// Categories that are useful waypoints but not ride destinations
const UTILITY_CATEGORIES = new Set([
  'wc', 'parking', 'utility', 'detour', 'flooding',
  'toilets', 'bicycle_parking', 'waste_basket',
]);

const MAX_INFRA_DIST_M = 3000;
const PROXIMITY_BONUS_CLOSE_M = 200;
const PROXIMITY_BONUS_NEAR_M = 800;
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
 * Curated places (from the data repo) bypass the proximity filter — they're
 * destinations worth riding to even if they're far from existing infrastructure.
 *
 * @param {Array<{ name, lat, lng, type, osmType, osmId, tags }>} pois
 * @param {Array} axes - output of detectAxes()
 * @param {Array} [curatedPlaces] - places from the data repo (optional)
 * @returns {Array<{ ...poi, anchorScore, distToInfraM }>} sorted by anchorScore desc
 */
export function scoreAnchors(pois, axes, curatedPlaces = []) {
  const points = infraPoints(axes);

  if (points.length === 0) {
    console.warn('[anchors] No infrastructure points found — returning empty anchor list');
    return [];
  }

  // Score and filter each POI
  const scored = [];
  for (const poi of pois) {
    // Skip utility POIs — they're useful stops but not ride destinations
    if (UTILITY_CATEGORIES.has(poi.type)) continue;

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

  // Add curated places — these bypass the proximity filter because they're
  // hand-picked destinations. They get the highest base score.
  for (const place of curatedPlaces) {
    if (UTILITY_CATEGORIES.has(place.type)) continue;
    const poiCoord = [place.lng, place.lat];
    let minDist = Infinity;
    for (const pt of points) {
      const d = haversineM(poiCoord, pt);
      if (d < minDist) minDist = d;
    }

    scored.push({
      ...place,
      anchorScore: ANCHOR_SCORES.curated + (minDist < PROXIMITY_BONUS_CLOSE_M ? 2 : 0),
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

// ---------------------------------------------------------------------------
// Destination zone clustering
// ---------------------------------------------------------------------------

const ZONE_RADIUS_M = 500;

/**
 * Cluster anchors into destination zones. A zone with a beach + park + cafe
 * is a stronger destination than any one POI alone.
 *
 * Each zone gets a boosted score based on POI density and variety.
 * The zone's representative anchor is the highest-scored POI in the cluster.
 *
 * @param {Array} anchors - scored anchors from scoreAnchors()
 * @returns {Array} anchors with zone-boosted scores, sorted desc
 */
export function clusterDestinationZones(anchors) {
  const assigned = new Set();
  const zones = [];

  // Sort by score desc so zone representatives are the best POIs
  const sorted = [...anchors].sort((a, b) => b.anchorScore - a.anchorScore);

  for (let i = 0; i < sorted.length; i++) {
    if (assigned.has(i)) continue;
    const center = sorted[i];
    const members = [center];
    assigned.add(i);

    for (let j = i + 1; j < sorted.length; j++) {
      if (assigned.has(j)) continue;
      if (haversineM([center.lng, center.lat], [sorted[j].lng, sorted[j].lat]) <= ZONE_RADIUS_M) {
        members.push(sorted[j]);
        assigned.add(j);
      }
    }

    // Zone score: representative score + bonus for variety
    const types = new Set(members.map((m) => m.type));
    const varietyBonus = Math.min(types.size - 1, 3); // up to +3 for diverse zone
    const densityBonus = Math.min(members.length - 1, 3); // up to +3 for dense zone

    zones.push({
      ...center,
      anchorScore: center.anchorScore + varietyBonus + densityBonus,
      zoneMembers: members.length,
      zoneTypes: [...types],
    });
  }

  return zones.sort((a, b) => b.anchorScore - a.anchorScore);
}
