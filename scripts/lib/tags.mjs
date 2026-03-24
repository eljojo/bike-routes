/**
 * Semantic tag assignment for route candidates.
 *
 * Derives English tag keys from route data: surface type, infrastructure
 * descriptors, terrain, difficulty, and comunas.
 */

/**
 * Assign semantic tags to a route object.
 *
 * @param {object} route - must have .axes, .infraPercent, .gaps, .avgConditionScore
 * @returns {string[]} deduplicated array of tag keys
 */
export function assignTags(route) {
  const tags = new Set();

  // Collect all segments across all axes
  const allSegments = route.axes.flatMap((a) => a.segments);

  // --- Surface type ---
  // Any infrastructure at all gets 'bike path'
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

  // --- Difficulty ---
  const maxGapM =
    route.gaps.length > 0
      ? Math.max(...route.gaps.map((g) => g.distanceM))
      : 0;

  // Average width across all segments that have ancho_cm
  const widths = allSegments
    .map((s) => s.ancho_cm)
    .filter((w) => w != null && w > 0);
  const avgWidthCm = widths.length > 0
    ? widths.reduce((a, b) => a + b, 0) / widths.length
    : 0;

  if (
    route.infraPercent > 80 &&
    route.avgConditionScore >= 5 &&
    maxGapM < 300 &&
    avgWidthCm >= 180
  ) {
    tags.add('easy');
    tags.add('family friendly');
  }

  if (route.infraPercent < 50 || maxGapM > 800) {
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
