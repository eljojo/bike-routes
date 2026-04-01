import { haversineM } from './geo.mjs';

/**
 * Road classification priority — higher-class roads are more likely to have
 * parallel bike lanes than residential side streets.
 */
const ROAD_CLASS_RANK = {
  primary: 0,
  secondary: 1,
  tertiary: 2,
  unclassified: 3,
  residential: 4,
};

/**
 * Select the best road from candidates returned by an Overpass `around` query.
 *
 * When a cycleway segment sits near an intersection, multiple roads are within
 * range. A short residential side street may be closer to the midpoint than the
 * major road the bike lane actually parallels. This function ranks candidates
 * by road classification (primary > secondary > tertiary > unclassified > residential),
 * breaking ties by distance to the query point.
 *
 * @param {Array<{ tags: object, center?: { lat: number, lon: number } }>} roads
 *   Overpass way elements with at least `tags.highway` and `tags.name`
 * @param {{ lat: number, lon: number }} queryPoint
 *   The point used in the `around` query (chain midpoint)
 * @returns {{ name: string, highway: string } | null}
 */
export function selectBestRoad(roads, queryPoint) {
  if (!roads || roads.length === 0) return null;

  const scored = roads
    .filter(r => r.tags?.name && r.tags?.highway)
    .map(r => {
      const rank = ROAD_CLASS_RANK[r.tags.highway] ?? 3;
      const dist = r.center
        ? haversineM([r.center.lon, r.center.lat], [queryPoint.lon, queryPoint.lat])
        : Infinity;
      return { name: r.tags.name, highway: r.tags.highway, rank, dist };
    });

  if (scored.length === 0) return null;

  // Sort by road class first, then by distance as tiebreaker
  scored.sort((a, b) => a.rank - b.rank || a.dist - b.dist);

  return { name: scored[0].name, highway: scored[0].highway };
}
