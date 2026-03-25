/**
 * Curate the launch set of routes from a large candidate pool.
 *
 * Finds the oases — routes where someone new to cycling would
 * have a good time. Prioritises:
 *
 * 1. Going somewhere worth going (anchor POI quality)
 * 2. Feeling safe getting there (infrastructure coverage)
 * 3. Showing the whole city (geographic spread)
 * 4. Variety of distance (short + medium + long)
 * 5. Being real (has video footage)
 */

/**
 * Select the launch set from all candidates.
 *
 * @param {object} proposals - full proposals object with .routes and .anchors
 * @param {object} opts
 * @param {number} opts.target - target number of routes (default 30)
 * @returns {object[]} curated routes, sorted by interest
 */
export function curateLaunchSet(proposals, opts = {}) {
  const target = opts.target || 30;
  const routes = proposals.routes;
  const anchorLookup = new Map(proposals.anchors.map((a) => [a.name, a]));

  // Score every route by "would a new rider enjoy this?"
  const scored = routes.map((r) => {
    const startData = anchorLookup.get(r.startAnchor.name);
    const endData = anchorLookup.get(r.endAnchor.name);

    // Destination quality — parks and plazas are why people ride
    const destinationScore = (startData?.anchorScore || 0) + (endData?.anchorScore || 0);

    // Distance: the sweet spot is broad. Don't punish long routes —
    // a 25km river corridor is exactly what experienced riders want to find.
    const distKm = r.totalDistanceM / 1000;
    const distScore =
      distKm >= 5 && distKm <= 30 ? 5 :
      distKm >= 2 && distKm <= 40 ? 3 : 0;

    // Safety — high infrastructure coverage means fewer scary moments
    const safetyScore = Math.min(r.infraPercent / 20, 5);

    // Condition — good infrastructure vs crumbling paint
    const conditionScore = r.avgConditionScore || 0;

    // Show don't tell — video lets people see what it's like
    const videoScore = Math.min(r.videos.length, 5);

    // Name quality — "De Parque X a Parque Y" is better than
    // "De Bandejon Central a Bandejon Central"
    const nameScore = assessNameQuality(r.startAnchor.name, r.endAnchor.name);

    // Greenery — routes through parks and along rivers are where joy lives
    const allSegs = r.axes.flatMap((a) => a.segments);
    const totalLengthM = allSegs.reduce((s, seg) => s + (seg.lengthM || 0), 0);
    const parkLengthM = allSegs.filter((s) => s.emplazamiento === 'parque').reduce((s, seg) => s + (seg.lengthM || 0), 0);
    const parkFraction = totalLengthM > 0 ? parkLengthM / totalLengthM : 0;
    // Smooth scale: no cliff edges. 17% park gets 3.4 instead of jumping from 2 to 5 at 20%.
    const greenScore = Math.min(parkFraction * 20, 6);

    // Archetype variety — loops and spines are more interesting
    const archetypeScore = r.archetype === 'loop' ? 5 : 0;

    // Corridor bonus — routes that span 3+ comunas are corridor rides
    // (along a river, through a park chain, across the city). These are
    // the signature rides that define a city's cycling character.
    const comunaCount = new Set(r.axes.flatMap((a) => a.comunas || [])).size;
    const corridorBonus = comunaCount >= 4 ? 6 : comunaCount >= 3 ? 3 : 0;

    // Routes with lots of gaps are not real routes
    // Penalize both low overall infra AND single large exposed gaps
    const maxGapM = r.gaps.length > 0 ? Math.max(...r.gaps.map(g => g.distanceM)) : 0;
    const infraPenalty = r.infraPercent < 70 ? 5 : r.infraPercent < 80 ? 2 : 0;
    const singleGapPenalty = maxGapM > 1000 ? 3 : maxGapM > 500 ? 1 : 0;
    const gapPenalty = infraPenalty + singleGapPenalty;

    // Zone interest — routes through interesting zones score higher
    const zoneBonus = r.zoneInterest || 0;

    const interestScore =
      destinationScore * 1.5 +
      distScore * 2 +
      safetyScore * 3 +
      conditionScore +
      videoScore +
      nameScore * 1.5 +
      greenScore +
      archetypeScore +
      corridorBonus +
      zoneBonus * 2 -
      gapPenalty;

    return { ...r, interestScore, distKm };
  });

  // Sort by interest
  scored.sort((a, b) => b.interestScore - a.interestScore);

  // Greedy selection with diversity constraints
  // Pre-compute geographic footprint for each route (200m grid cells).
  // Used to detect overlapping routes covering the same ground.
  const FOOTPRINT_GRID = 0.002; // ~200m
  function routeFootprint(route) {
    const cells = new Set();
    for (const axis of route.axes) {
      for (const seg of axis.segments) {
        const coords = seg.geometry.type === 'MultiLineString'
          ? seg.geometry.coordinates.flat() : seg.geometry.coordinates;
        for (const c of coords) {
          cells.add(`${Math.floor(c[0] / FOOTPRINT_GRID)},${Math.floor(c[1] / FOOTPRINT_GRID)}`);
        }
      }
    }
    return cells;
  }

  const selected = [];
  const selectedFootprints = [];
  const anchorUsed = new Map();
  const comunaUsed = new Map();

  for (const route of scored) {
    if (selected.length >= target) break;

    // Skip duplicates — same start+end anchor pair (but not loops)
    if (route.archetype !== 'loop') {
      const pairKey = [route.startAnchor.name, route.endAnchor.name].sort().join('|');
      if (selected.some((s) => {
        if (s.archetype === 'loop') return false;
        const k = [s.startAnchor.name, s.endAnchor.name].sort().join('|');
        return k === pairKey;
      })) continue;
    }

    // Geographic overlap — reject routes covering >50% same ground
    // as an already-selected route. Kills "three overlapping Mapocho routes."
    const footprint = routeFootprint(route);
    let tooMuchOverlap = false;
    for (const existingFP of selectedFootprints) {
      let overlap = 0;
      for (const cell of footprint) {
        if (existingFP.has(cell)) overlap++;
      }
      const overlapRatio = overlap / Math.min(footprint.size, existingFP.size);
      if (overlapRatio > 0.5) {
        tooMuchOverlap = true;
        break;
      }
    }
    if (tooMuchOverlap) continue;

    // Geographic spread — per-comuna cap
    const comunas = [...new Set(route.axes.flatMap((a) => a.comunas || []))];
    const maxComunaHits = Math.max(...comunas.map((c) => comunaUsed.get(c) || 0));
    if (maxComunaHits >= 8) continue;

    // Anchor spread
    const startCount = anchorUsed.get(route.startAnchor.name) || 0;
    const endCount = anchorUsed.get(route.endAnchor.name) || 0;
    if (startCount >= 5 || endCount >= 5) continue;

    selected.push(route);
    selectedFootprints.push(footprint);
    for (const c of comunas) {
      comunaUsed.set(c, (comunaUsed.get(c) || 0) + 1);
    }
    anchorUsed.set(route.startAnchor.name, startCount + 1);
    anchorUsed.set(route.endAnchor.name, endCount + 1);
  }

  // Check distance variety
  const short = selected.filter((r) => r.distKm < 5).length;
  const medium = selected.filter((r) => r.distKm >= 5 && r.distKm < 10).length;
  const long = selected.filter((r) => r.distKm >= 10).length;
  const comunasCount = new Set(selected.flatMap((r) => r.axes.flatMap((a) => a.comunas))).size;

  console.log(`\nCuration: ${selected.length} routes selected`);
  console.log(`  Short (<5km): ${short}, Medium (5-10km): ${medium}, Long (10+km): ${long}`);
  console.log(`  Comunas covered: ${comunasCount}`);
  console.log(`  Avg infrastructure: ${Math.round(selected.reduce((s, r) => s + r.infraPercent, 0) / selected.length)}%`);

  return selected;
}

/**
 * How good is this route name? Penalise generic/ugly names.
 * A "Parque" or "Plaza" with a real name > "Bandejon" or "Rotonda".
 */
function assessNameQuality(startName, endName) {
  let score = 0;
  for (const name of [startName, endName]) {
    const lower = name.toLowerCase();
    // Good: recognisable place types
    if (lower.includes('parque') || lower.includes('plaza')) score += 2;
    if (lower.includes('mercado') || lower.includes('museo')) score += 2;
    if (lower.includes('río') || lower.includes('cerro')) score += 2;
    // OK but generic
    if (lower.includes('estación') || lower.includes('station')) score += 1;
    // Ugly: infrastructure names nobody knows
    if (lower.includes('bandejon') || lower.includes('rotonda')) score -= 1;
    if (lower.includes('acceso') || lower.includes('óvalo')) score -= 1;
    // Same start and end is a loop or mistake
    if (startName === endName) score -= 3;
  }
  return Math.max(0, score);
}
