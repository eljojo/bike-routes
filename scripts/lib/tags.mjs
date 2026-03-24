/**
 * Semantic tag assignment for route candidates.
 *
 * Tags are English keys that drive app behaviour (difficulty scoring,
 * surface classification, tag filtering). They get displayed in the
 * user's language via tag-translations.yml.
 *
 * Key insight: infrastructure *condition* (mala/buena) is not the same
 * as riding *difficulty*. A "mala" rated bike lane is still infinitely
 * safer than no bike lane for a new rider. Difficulty comes from:
 * gaps (forced into traffic), distance, and terrain.
 */

/**
 * Assign semantic tags to a route object.
 *
 * @param {object} route - must have .axes, .infraPercent, .gaps, .avgConditionScore
 * @returns {string[]} deduplicated array of tag keys
 */
export function assignTags(route) {
  const tags = new Set();

  const allSegments = route.axes.flatMap((a) => a.segments);

  // --- Surface type ---
  if (allSegments.length > 0) {
    tags.add('bike path');
  }

  // --- Infrastructure descriptors ---
  for (const seg of allSegments) {
    if (seg.tipo === 'unidireccional') tags.add('protected lane');
    if (seg.emplazamiento === 'parque') tags.add('park path');
    if (seg.emplazamiento === 'mediana') tags.add('median lane');
  }

  // --- Terrain ---
  tags.add('flat');

  // --- Difficulty from RIDING experience, not paint quality ---
  // What matters: how much of the ride has infrastructure (coverage),
  // how long the gaps are (exposure to traffic), and width (comfort).
  const maxGapM =
    route.gaps.length > 0
      ? Math.max(...route.gaps.map((g) => g.distanceM))
      : 0;

  const widths = allSegments
    .map((s) => s.ancho_cm)
    .filter((w) => w != null && w > 0);
  const avgWidthCm = widths.length > 0
    ? widths.reduce((a, b) => a + b, 0) / widths.length
    : 0;

  // Family friendly: high coverage, short gaps, decent width
  // Note: condition score intentionally NOT required — a crumbling
  // bike lane is still separated from cars
  if (route.infraPercent > 80 && maxGapM < 300 && avgWidthCm >= 150) {
    tags.add('easy');
    tags.add('family friendly');
  }

  // Hard: significant gaps force riders onto busy roads
  if (route.infraPercent < 50 || maxGapM > 1000) {
    tags.add('hard');
  }

  // --- Comunas ---
  for (const axis of route.axes) {
    for (const comuna of axis.comunas) {
      if (comuna) tags.add(comuna);
    }
  }

  return [...tags];
}
