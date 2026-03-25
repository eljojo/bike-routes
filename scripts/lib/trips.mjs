/**
 * Pass 3 — Trip stitching.
 *
 * Generates candidate routes by exploring segment-level graphs,
 * then assigning the best anchors to each route's endpoints.
 *
 * v3: segment-level search replaces axis-chain DFS.
 *     - buildSegmentGraph(): 2255-node graph with spatial grid
 *     - searchOneWayRoutes(): greedy best-first toward distant anchors
 *     - searchLoopRoutes(): quadrant-sweep loops around high-score anchors
 *     - segmentsToAxisChain(): partial axis usage
 */

import { haversineM, minEndpointDistance } from './geo.mjs';
import { slugify } from './slugify.mjs';
import { assignTags } from './tags.mjs';
import { validateTrace } from './trace.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_ROUTE_KM = 2;
const MAX_ROUTE_KM = 80;
const MAX_GAP_M = 2000;
const AXIS_TO_ANCHOR_THRESHOLD_M = 3000;
const MIN_ANCHOR_SCORE = 5;
const MAX_CHAIN_AXES = 8;
const DEDUP_OVERLAP_THRESHOLD = 0.6;
// Point-to-point: total distance / crow-flies. A straight line = 1.0.
// Urban cycling typically 1.5–3.0. Above 3.5 means zigzag garbage.
const MAX_DETOUR_RATIO = 3.5;
// Loops get a more lenient ratio (measured as total / diameter of bounding box)
const MAX_LOOP_DETOUR_RATIO = 5;

// Segment graph constants
const GRID_CELL_DEG = 0.005; // ~500m cells for spatial index
const SAME_AXIS_COST = 0;
const MAX_SEG_SEARCH_STEPS = 300; // greedy search budget per start
const MIN_LOOP_SEGS = 6;

// ---------------------------------------------------------------------------
// Helpers (preserved from v2)
// ---------------------------------------------------------------------------

/** Centroid of an axis (average of segment centroids). */
function axisCentroid(axis) {
  let sumLng = 0, sumLat = 0;
  for (const seg of axis.segments) {
    sumLng += seg.centroid[0];
    sumLat += seg.centroid[1];
  }
  const n = axis.segments.length;
  return [sumLng / n, sumLat / n];
}

/**
 * Direction vector from first to last segment centroid.
 * Returns [dx, dy] in degrees (not normalized — length indicates axis extent).
 */
function axisDirection(axis) {
  const first = axis.segments[0].centroid;
  const last = axis.segments[axis.segments.length - 1].centroid;
  return [last[0] - first[0], last[1] - first[1]];
}

/** Dot product of 2D vectors. */
function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }

/**
 * How well does axis B continue the direction of travel from axis A?
 * Returns a value from -1 (reverses) to +1 (continues perfectly).
 * Uses the vector from A's centroid to B's centroid vs A's direction.
 */
function directionScore(axisA, axisB) {
  const dirA = axisDirection(axisA);
  const centA = axisCentroid(axisA);
  const centB = axisCentroid(axisB);
  const toB = [centB[0] - centA[0], centB[1] - centA[1]];
  const magA = Math.sqrt(dot(dirA, dirA));
  const magB = Math.sqrt(dot(toB, toB));
  if (magA < 1e-10 || magB < 1e-10) return 0;
  return dot(dirA, toB) / (magA * magB);
}

/**
 * Check if gaps go roughly along the route direction, not sideways.
 * A gap that goes perpendicular to the overall route is a red flag —
 * it means the route jumps to a parallel corridor.
 *
 * Returns true if all gaps are directionally coherent.
 */
function gapsAreCoherent(axisChain) {
  if (axisChain.length < 2) return true;

  // Overall route direction: first axis start → last axis end
  const firstSegs = axisChain[0].segments;
  const lastSegs = axisChain[axisChain.length - 1].segments;
  const routeDir = [
    lastSegs[lastSegs.length - 1].centroid[0] - firstSegs[0].centroid[0],
    lastSegs[lastSegs.length - 1].centroid[1] - firstSegs[0].centroid[1],
  ];
  const routeMag = Math.sqrt(dot(routeDir, routeDir));
  if (routeMag < 1e-10) return true; // essentially same point (loop)

  for (let i = 1; i < axisChain.length; i++) {
    const prevSegs = axisChain[i - 1].segments;
    const currSegs = axisChain[i].segments;
    const prevEnd = prevSegs[prevSegs.length - 1].centroid;
    const currStart = currSegs[0].centroid;
    const gapDir = [currStart[0] - prevEnd[0], currStart[1] - prevEnd[1]];
    const gapMag = Math.sqrt(dot(gapDir, gapDir));

    // Only check gaps that are significant (>300m)
    const gapDist = haversineM(prevEnd, currStart);
    if (gapDist < 300) continue;

    if (gapMag < 1e-10) continue;
    const cosAngle = dot(routeDir, gapDir) / (routeMag * gapMag);
    // cos(70°) ≈ 0.34 — reject gaps more than 70° off the route direction
    if (cosAngle < -0.17) return false; // gap goes backwards
    // Also check if gap is purely sideways (|cos| < 0.34 means >70° off)
    if (Math.abs(cosAngle) < 0.34 && gapDist > 500) return false;
  }
  return true;
}

/**
 * Detour ratio: total path distance / crow-flies distance between endpoints.
 * Lower is more coherent. A straight line = 1.0.
 */
function detourRatio(axisChain, totalDistanceM) {
  if (axisChain.length === 1) return 1;
  const firstSegs = axisChain[0].segments;
  const lastSegs = axisChain[axisChain.length - 1].segments;
  const start = firstSegs[0].start;
  const end = lastSegs[lastSegs.length - 1].end;
  const crowFlies = haversineM(start, end);
  if (crowFlies < 100) return totalDistanceM / 1000; // essentially a loop
  return totalDistanceM / crowFlies;
}

/** Distance from an anchor [lng, lat] to the nearest endpoint of an axis. */
function anchorToAxisDist(anchor, axis) {
  const anchorCoord = [anchor.lng, anchor.lat];
  let minDist = Infinity;
  for (const seg of axis.segments) {
    const ds = haversineM(anchorCoord, seg.start);
    const de = haversineM(anchorCoord, seg.end);
    if (ds < minDist) minDist = ds;
    if (de < minDist) minDist = de;
  }
  return minDist;
}

/**
 * Find the minimum gap between two axes, considering both orientations.
 * Returns { distance, from, to } where from/to are [lng, lat] coords.
 */
function minAxesGap(prev, curr) {
  const prevFirst = prev.segments[0];
  const prevLast = prev.segments[prev.segments.length - 1];
  const currFirst = curr.segments[0];
  const currLast = curr.segments[curr.segments.length - 1];

  // Check all 4 endpoint pairs (prev can exit from either end,
  // curr can be entered from either end)
  const pairs = [
    { from: prevLast.end, to: currFirst.start },
    { from: prevLast.end, to: currLast.end },
    { from: prevFirst.start, to: currFirst.start },
    { from: prevFirst.start, to: currLast.end },
  ];

  let best = { distance: Infinity, from: null, to: null };
  for (const p of pairs) {
    const d = haversineM(p.from, p.to);
    if (d < best.distance) best = { distance: d, from: p.from, to: p.to };
  }
  return best;
}

/** Compute gaps between consecutive axes in a chain. */
function computeGaps(axisChain) {
  const gaps = [];
  for (let i = 1; i < axisChain.length; i++) {
    const prev = axisChain[i - 1];
    const curr = axisChain[i];
    const { distance, from, to } = minAxesGap(prev, curr);
    if (distance > 10) {
      gaps.push({
        afterAxis: prev.slug,
        distanceM: Math.round(distance),
        from,
        to,
      });
    }
  }
  return gaps;
}

/** Tiered gap penalty: crossing a street != riding 2km on a road. */
function computeGapPenalty(gaps) {
  let penalty = 0;
  for (const gap of gaps) {
    const d = gap.distanceM;
    if (d < 200) {
      penalty += d / 2000;
    } else if (d < 1000) {
      penalty += 0.1 + (d - 200) / 800;
    } else {
      penalty += 1.1 + (d - 1000) / 500;
    }
  }
  return Math.min(penalty, 8);
}

/** Detect route archetype: mountain, loop, or one-way. */
function detectArchetype(axisChain, startAnchor, endAnchor) {
  // Mountain/trail detection — different scoring regime
  const allSegs = axisChain.flatMap((a) => a.segments);
  const totalLen = allSegs.reduce((s, seg) => s + (seg.lengthM || 0), 0);
  const parkLen = allSegs.filter((s) => s.emplazamiento === 'parque').reduce((s, seg) => s + (seg.lengthM || 0), 0);
  const parkFrac = totalLen > 0 ? parkLen / totalLen : 0;

  const mountainNames = ['cerro', 'sendero', 'mtb', 'trail', 'mahuida', 'manquehue'];
  const hasTrailName = axisChain.some((a) => {
    const n = (a.name || '').toLowerCase();
    return mountainNames.some((m) => n.includes(m));
  });

  if (parkFrac > 0.5 || hasTrailName) return 'mountain';

  const sameAnchor =
    startAnchor.name === endAnchor.name ||
    haversineM([startAnchor.lng, startAnchor.lat], [endAnchor.lng, endAnchor.lat]) < 500;

  if (sameAnchor && axisChain.length >= 2) return 'loop';
  return 'one-way';
}

/**
 * Loop shape quality: how round/oval is this loop?
 *
 * Measures two things:
 * - Aspect ratio: bounding box width/height (1.0 = square, >3 = narrow slit)
 * - Perimeter efficiency: route distance / (2 * (width + height))
 *   (0.8-1.0 = traces the perimeter cleanly, <0.5 = zigzag or narrow)
 *
 * Returns { aspect, perimEff, isOval, isPaperclip, hasHubRevisit }
 */
function loopShape(axisChain, totalDistanceM) {
  const coords = [];
  for (const ax of axisChain) {
    for (const seg of ax.segments) {
      const geo = seg.geometry;
      const c = geo.type === 'MultiLineString' ? geo.coordinates.flat() : geo.coordinates;
      coords.push(...c);
    }
  }
  if (coords.length < 4) return { aspect: 99, perimEff: 0, isOval: false };

  const lats = coords.map((c) => c[1]);
  const lngs = coords.map((c) => c[0]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const width = haversineM([minLng, (minLat + maxLat) / 2], [maxLng, (minLat + maxLat) / 2]);
  const height = haversineM([(minLng + maxLng) / 2, minLat], [(minLng + maxLng) / 2, maxLat]);

  if (width < 100 || height < 100) return { aspect: 99, perimEff: 0, isOval: false };

  const aspect = Math.max(width, height) / Math.min(width, height);
  const perimEff = totalDistanceM / (2 * (width + height));

  // Paperclip detection: a real O-shaped loop has outbound and return
  // legs on different corridors. A paperclip rides up one side of an
  // avenue and back down the other — the two halves overlap.
  // Split coordinates in half and check if the halves are separated.
  const mid = Math.floor(coords.length / 2);
  const firstHalf = coords.slice(0, mid);
  const secondHalf = coords.slice(mid);
  const overlapRadius = Math.min(300 + totalDistanceM / 20, 1500);
  let overlapCount = 0;
  const sampleStep = Math.max(1, Math.floor(firstHalf.length / 20)); // sample ~20 points
  for (let i = 0; i < firstHalf.length; i += sampleStep) {
    const pt = firstHalf[i];
    for (let j = 0; j < secondHalf.length; j += sampleStep) {
      if (haversineM(pt, secondHalf[j]) < overlapRadius) {
        overlapCount++;
        break;
      }
    }
  }
  const sampledPoints = Math.ceil(firstHalf.length / sampleStep);
  const overlapFraction = sampledPoints > 0 ? overlapCount / sampledPoints : 0;
  const isPaperclip = overlapFraction > 0.4;

  // Hub/star detection
  let hasHubRevisit = false;
  if (axisChain.length >= 3) {
    const junctionPoints = [];
    for (let i = 0; i < axisChain.length; i++) {
      const segs = axisChain[i].segments;
      junctionPoints.push(segs[0].start);
      junctionPoints.push(segs[segs.length - 1].end);
    }
    let hubCount = 0;
    for (let i = 0; i < junctionPoints.length; i++) {
      for (let j = i + 3; j < junctionPoints.length; j++) {
        if (haversineM(junctionPoints[i], junctionPoints[j]) < 200) {
          hubCount++;
        }
      }
    }
    hasHubRevisit = hubCount >= 2 || (hubCount >= 1 && perimEff < 0.5);
  }

  const isOval = aspect < 2.5 && perimEff > 0.55 && !isPaperclip && !hasHubRevisit;

  return { aspect, perimEff, isOval, isPaperclip, hasHubRevisit };
}

/** Title-case a string (handles ñ, lowercases first). */
function titleCase(str) {
  return str
    .toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Reorder axes to minimize total gap distance (nearest-neighbor + 2-opt).
 *
 * Direction-aware: each axis has a start and end, and entering from one end
 * means you exit from the other. A 12km axis going north means you exit at
 * the north end — the optimizer tracks this to avoid backtracking.
 *
 * For loops, tries all starting axes and directions, then applies 2-opt
 * improvement swaps to reduce the worst gaps.
 */
function optimizeAxisOrder(axisChain, isLoop = false) {
  if (axisChain.length <= 2) return axisChain;

  const eps = axisChain.map((a) => ({
    start: a.segments[0].start,
    end: a.segments[a.segments.length - 1].end,
    centroid: axisCentroid(a),
  }));

  /** Compute total gap for a given order + direction assignment. */
  function totalGapForOrder(order, dirs) {
    let total = 0;
    for (let i = 1; i < order.length; i++) {
      const prevExit = dirs[i - 1] ? eps[order[i - 1]].start : eps[order[i - 1]].end;
      const currEntry = dirs[i] ? eps[order[i]].end : eps[order[i]].start;
      total += haversineM(prevExit, currEntry);
    }
    if (isLoop && order.length >= 2) {
      const lastExit = dirs[order.length - 1] ? eps[order[order.length - 1]].start : eps[order[order.length - 1]].end;
      const firstEntry = dirs[0] ? eps[order[0]].end : eps[order[0]].start;
      total += haversineM(lastExit, firstEntry);
    }
    return total;
  }

  /** Determine optimal directions for a given order using greedy forward pass. */
  function assignDirections(order, startReversed) {
    const dirs = new Array(order.length).fill(false);
    dirs[0] = startReversed;
    let pos = startReversed ? eps[order[0]].start : eps[order[0]].end;
    for (let i = 1; i < order.length; i++) {
      const idx = order[i];
      const dS = haversineM(pos, eps[idx].start);
      const dE = haversineM(pos, eps[idx].end);
      dirs[i] = dE < dS;
      pos = dirs[i] ? eps[idx].start : eps[idx].end;
    }
    return dirs;
  }

  // --- For loops: angular ordering around centroid ---
  // Sort axes by the angle from the loop's centroid to each axis's centroid.
  // This traces a circle: NE → SE → SW → NW → back to NE.
  // Try both clockwise and counterclockwise, pick the one with less total gap.
  if (isLoop) {
    // Compute centroid of all axes
    let cx = 0, cy = 0;
    for (const e of eps) { cx += e.centroid[0]; cy += e.centroid[1]; }
    cx /= eps.length; cy /= eps.length;

    // Compute angle from centroid for each axis
    const withAngle = eps.map((e, i) => ({
      idx: i,
      angle: Math.atan2(e.centroid[0] - cx, e.centroid[1] - cy),
    }));

    // Sort by angle (counterclockwise)
    const ccw = [...withAngle].sort((a, b) => a.angle - b.angle).map((a) => a.idx);
    // Clockwise = reversed
    const cw = [...ccw].reverse();

    let best = { order: ccw, dirs: [], totalGap: Infinity };

    // Try both directions, starting from each axis
    for (const baseOrder of [ccw, cw]) {
      for (let offset = 0; offset < baseOrder.length; offset++) {
        // Rotate: start from different axis
        const order = [...baseOrder.slice(offset), ...baseOrder.slice(0, offset)];
        for (const startRev of [false, true]) {
          const dirs = assignDirections(order, startRev);
          const gap = totalGapForOrder(order, dirs);
          if (gap < best.totalGap) {
            best = { order, dirs, totalGap: gap };
          }
        }
      }
    }

    // 2-opt improvement on the angular order
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < best.order.length - 1; i++) {
        for (let j = i + 1; j < best.order.length; j++) {
          const newOrder = [...best.order];
          [newOrder[i], newOrder[j]] = [newOrder[j], newOrder[i]];
          for (const startRev of [false, true]) {
            const newDirs = assignDirections(newOrder, startRev);
            const newGap = totalGapForOrder(newOrder, newDirs);
            if (newGap < best.totalGap) {
              best = { order: newOrder, dirs: newDirs, totalGap: newGap };
              improved = true;
            }
          }
        }
      }
    }

    return best.order.map((i, pos) => {
      const axis = axisChain[i];
      axis._reversed = best.dirs[pos];
      return axis;
    });
  }

  // --- For one-way: nearest-neighbor + 2-opt ---
  function nnFrom(startIdx, startReversed) {
    const remaining = new Set(axisChain.map((_, i) => i));
    const order = [startIdx];
    remaining.delete(startIdx);
    let pos = startReversed ? eps[startIdx].start : eps[startIdx].end;

    while (remaining.size > 0) {
      let bestIdx = -1, bestDist = Infinity, bestReversed = false;
      for (const idx of remaining) {
        const dS = haversineM(pos, eps[idx].start);
        const dE = haversineM(pos, eps[idx].end);
        if (dS < bestDist) { bestDist = dS; bestIdx = idx; bestReversed = false; }
        if (dE < bestDist) { bestDist = dE; bestIdx = idx; bestReversed = true; }
      }
      if (bestIdx < 0) break;
      order.push(bestIdx);
      remaining.delete(bestIdx);
      pos = bestReversed ? eps[bestIdx].start : eps[bestIdx].end;
    }
    const dirs = assignDirections(order, startReversed);
    return { order, dirs, totalGap: totalGapForOrder(order, dirs) };
  }

  let best = { order: axisChain.map((_, i) => i), dirs: new Array(axisChain.length).fill(false), totalGap: Infinity };
  for (const rev of [false, true]) {
    const result = nnFrom(0, rev);
    if (result.totalGap < best.totalGap) best = result;
  }

  // 2-opt improvement
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.order.length - 1; i++) {
      for (let j = i + 1; j < best.order.length; j++) {
        const newOrder = [...best.order];
        [newOrder[i], newOrder[j]] = [newOrder[j], newOrder[i]];
        for (const startRev of [false, true]) {
          const newDirs = assignDirections(newOrder, startRev);
          const newGap = totalGapForOrder(newOrder, newDirs);
          if (newGap < best.totalGap) {
            best = { order: newOrder, dirs: newDirs, totalGap: newGap };
            improved = true;
          }
        }
      }
    }
  }

  return best.order.map((i, pos) => {
    const axis = axisChain[i];
    axis._reversed = best.dirs[pos];
    return axis;
  });
}

/** Generate a name based on route archetype. */
function generateName(archetype, axisChain, startAnchor, endAnchor) {
  const longestAxis = axisChain.reduce((best, a) =>
    a.totalInfraM > best.totalInfraM ? a : best, axisChain[0]);

  const axisName = longestAxis.name && !longestAxis.name.startsWith('unnamed')
    ? titleCase(longestAxis.name)
    : null;

  if (archetype === 'mountain') {
    return axisName ? `Sendero ${axisName}` : `Sendero ${startAnchor.name}`;
  }
  if (archetype === 'loop') {
    return axisName ? `Circuito ${axisName}` : `Circuito ${startAnchor.name}`;
  }
  // One-way: "De X a Y"
  return `De ${startAnchor.name} a ${endAnchor.name}`;
}

/** Build the route output object from axes and anchors. */
/** Max gap in the actual built route (not connection graph). */
const MAX_BUILT_GAP_M = 3000;

/**
 * Build route or return null if inviable.
 * @param {Array} [allAnchors] - all scored POIs for waypoint detection
 */
function buildRoute(axisChain, startAnchor, endAnchor, allAnchors = []) {
  // Detect archetype early to know if this is a loop (needed for optimization)
  const earlyArchetype = detectArchetype(axisChain, startAnchor, endAnchor);

  // Optimize axis order to minimize gap distances
  axisChain = optimizeAxisOrder(axisChain, earlyArchetype === 'loop');

  const gaps = computeGaps(axisChain);

  // Reject routes with any single gap too large in the actual trace.
  const maxGap = gaps.length > 0 ? Math.max(...gaps.map((g) => g.distanceM)) : 0;
  if (maxGap > MAX_BUILT_GAP_M) return null;

  // For loops, also check the closure gap (last axis → first axis).
  if (earlyArchetype === 'loop' && axisChain.length >= 2) {
    const closureGap = minAxesGap(axisChain[axisChain.length - 1], axisChain[0]);
    if (closureGap.distance > MAX_BUILT_GAP_M) return null;
  }

  // Reject routes with bad traces (teleporting, backtracking, zigzag)
  const traceSegs = axisChain.flatMap(a => a.segments);
  const traceCheck = validateTrace(traceSegs, earlyArchetype);
  if (!traceCheck.valid) return null;

  const infraDistanceM = axisChain.reduce((s, a) => s + a.totalInfraM, 0);
  const gapDistanceM = gaps.reduce((s, g) => s + g.distanceM, 0);
  const totalDistanceM = infraDistanceM + gapDistanceM;
  const infraPercent = totalDistanceM > 0
    ? Math.round((infraDistanceM / totalDistanceM) * 100)
    : 0;

  if (infraPercent < 60) return null;

  let scoreSum = 0;
  let scoreCount = 0;
  for (const axis of axisChain) {
    for (const seg of axis.segments) {
      const sc = Number(seg.score);
      if (!Number.isNaN(sc) && seg.score != null) {
        scoreSum += sc;
        scoreCount++;
      }
    }
  }
  const avgConditionScore = scoreCount > 0
    ? Math.round((scoreSum / scoreCount) * 10) / 10
    : 0;

  const videos = axisChain.flatMap((a) =>
    a.segments.filter((s) => s.video).map((s) => s.video),
  );

  const archetype = detectArchetype(axisChain, startAnchor, endAnchor);
  const name = generateName(archetype, axisChain, startAnchor, endAnchor);

  const route = {
    name,
    slug: slugify(name),
    archetype,
    startAnchor: { name: startAnchor.name, lat: startAnchor.lat, lng: startAnchor.lng, type: startAnchor.type },
    endAnchor: { name: endAnchor.name, lat: endAnchor.lat, lng: endAnchor.lng, type: endAnchor.type },
    axes: axisChain.map((a) => ({
      name: a.name,
      slug: a.slug,
      segments: a.segments.map((s) => ({
        nombre: s.nombre,
        comuna: s.comuna,
        lengthM: s.lengthM,
        tipo: s.tipo,
        emplazamiento: s.emplazamiento,
        ancho_cm: s.ancho_cm,
        clasificacion: s.clasificacion,
        score: s.score,
        video: s.video,
        surface: s.surface,
        lit: s.lit,
        geometry: s.geometry,
      })),
      comunas: a.comunas,
      totalInfraM: a.totalInfraM,
      _reversed: a._reversed,
    })),
    gaps,
    totalDistanceM: Math.round(totalDistanceM),
    infraDistanceM: Math.round(infraDistanceM),
    infraPercent,
    avgConditionScore,
    compositeScore: 0,
    videos,
    waypointPOIs: [],
    suggestedTags: [],
  };

  const infraScore = infraPercent / 10;
  const condScore = Math.min(avgConditionScore, 10);
  const gapPenalty = computeGapPenalty(gaps);
  const anchorScoreVal = (startAnchor.anchorScore + endAnchor.anchorScore) / 4;
  const longestAxis = Math.max(...axisChain.map((a) => a.totalInfraM));
  const signatureBonus = longestAxis > 5000 ? 3 : longestAxis > 3000 ? 1.5 : 0;
  const distKm = totalDistanceM / 1000;
  const distBonus = distKm < 4 ? -2 : distKm >= 5 && distKm <= 15 ? 1 : distKm >= 15 && distKm <= 40 ? 2 : 0;
  let archetypeBonus = 0;
  let coherenceBonus;
  if (archetype === 'loop') {
    const shape = loopShape(axisChain, totalDistanceM);
    archetypeBonus = shape.isOval ? 5 : 2;
    coherenceBonus = shape.perimEff > 0.7 ? 2 : shape.perimEff > 0.5 ? 1 : 0;
  } else {
    const ratio = detourRatio(axisChain, totalDistanceM);
    coherenceBonus = ratio < 1.5 ? 2 : ratio < 2.0 ? 1 : ratio < 2.5 ? 0 : -1;
  }

  // Mountain routes: different scoring
  if (archetype === 'mountain') {
    archetypeBonus = 3;
  }

  // --- "Oasis in the Desert" scoring ---
  const allSegs = axisChain.flatMap((a) => a.segments);

  const oasisSegs = allSegs.filter((s) =>
    s.emplazamiento === 'parque' || s.emplazamiento === 'mediana' || s.emplazamiento === 'bandejón');
  const exposedSegs = allSegs.filter((s) => s.emplazamiento === 'calzada');
  const totalLengthM = allSegs.reduce((s, seg) => s + (seg.lengthM || 0), 0);
  const oasisLengthM = oasisSegs.reduce((s, seg) => s + (seg.lengthM || 0), 0);
  const exposedLengthM = exposedSegs.reduce((s, seg) => s + (seg.lengthM || 0), 0);
  const oasisFraction = totalLengthM > 0 ? oasisLengthM / totalLengthM : 0;
  const exposedFraction = totalLengthM > 0 ? exposedLengthM / totalLengthM : 0;
  const segregationScore = oasisFraction * 5 - exposedFraction * 5;

  const parkSegs = allSegs.filter((s) => s.emplazamiento === 'parque');
  const parkLengthM = parkSegs.reduce((s, seg) => s + (seg.lengthM || 0), 0);
  const parkFraction = totalLengthM > 0 ? parkLengthM / totalLengthM : 0;
  const greenBonus = Math.min(parkFraction * 8, 4);

  let waypointBonus = 0;
  if (allAnchors.length > 0 && infraPercent >= 70) {
    const waypointTypes = new Set();
    const routeWaypoints = [];
    for (const anchor of allAnchors) {
      if (anchor.name === startAnchor.name || anchor.name === endAnchor.name) continue;
      const anchorCoord = [anchor.lng, anchor.lat];
      let found = false;
      for (const seg of allSegs) {
        if (haversineM(anchorCoord, seg.start) < 300 ||
            haversineM(anchorCoord, seg.end) < 300 ||
            haversineM(anchorCoord, seg.centroid) < 300) {
          found = true;
          break;
        }
      }
      if (found) {
        waypointTypes.add(anchor.type);
        routeWaypoints.push({ name: anchor.name, type: anchor.type, lat: anchor.lat, lng: anchor.lng });
      }
    }
    waypointBonus = Math.min(waypointTypes.size * 1.5, 6);
    route.waypointPOIs = routeWaypoints.slice(0, 10);
  }

  route.compositeScore = Math.round(
    (infraScore + condScore + anchorScoreVal + signatureBonus + distBonus + archetypeBonus + coherenceBonus + greenBonus + segregationScore + waypointBonus - gapPenalty) * 10,
  ) / 10;

  route.suggestedTags = assignTags(route);
  return route;
}

// ---------------------------------------------------------------------------
// A. Segment connection graph
// ---------------------------------------------------------------------------

/** Spatial grid key for a coordinate. */
function gridKey(coord) {
  const gx = Math.floor(coord[0] / GRID_CELL_DEG);
  const gy = Math.floor(coord[1] / GRID_CELL_DEG);
  return `${gx},${gy}`;
}

/**
 * Build a segment-level connection graph from all axes.
 *
 * Each segment becomes a node. Edges connect:
 * - Consecutive segments within the same axis (cost=0)
 * - Segments from different axes whose endpoints are close (cost=gap distance)
 *
 * Uses a spatial grid (~500m cells) for the cross-axis neighbor search.
 */
function buildSegmentGraph(axes, maxGapM = MAX_GAP_M) {
  const t0 = Date.now();

  // Flatten all segments, track which axis each belongs to
  const segments = [];
  const segToAxis = new Map(); // segIndex -> axisIndex
  const axisSegRanges = new Map(); // axisIndex -> { start, end } indices into segments[]

  for (let ai = 0; ai < axes.length; ai++) {
    const startIdx = segments.length;
    for (const seg of axes[ai].segments) {
      segToAxis.set(segments.length, ai);
      segments.push(seg);
    }
    axisSegRanges.set(ai, { start: startIdx, end: segments.length - 1 });
  }

  // Build spatial grid over segment endpoints
  const grid = new Map(); // gridKey -> [{ segIdx, coord, which: 'start'|'end' }]
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    for (const [which, coord] of [['start', seg.start], ['end', seg.end]]) {
      const key = gridKey(coord);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ segIdx: si, coord, which });
    }
  }

  // Build adjacency list: edges[segIdx] = [{ to, cost }]
  const edges = new Array(segments.length);
  for (let i = 0; i < segments.length; i++) edges[i] = [];

  let sameAxisEdges = 0;
  let crossAxisEdges = 0;

  // Same-axis edges: consecutive segments within each axis
  for (let ai = 0; ai < axes.length; ai++) {
    const range = axisSegRanges.get(ai);
    for (let si = range.start; si < range.end; si++) {
      edges[si].push({ to: si + 1, cost: SAME_AXIS_COST });
      edges[si + 1].push({ to: si, cost: SAME_AXIS_COST });
      sameAxisEdges += 2;
    }
  }

  // Cross-axis edges: segments from different axes with close endpoints
  // For each segment, check its neighborhood in the spatial grid
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const myAxis = segToAxis.get(si);

    for (const coord of [seg.start, seg.end]) {
      const gx = Math.floor(coord[0] / GRID_CELL_DEG);
      const gy = Math.floor(coord[1] / GRID_CELL_DEG);

      // Check 3x3 neighborhood of grid cells
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighborKey = `${gx + dx},${gy + dy}`;
          const cell = grid.get(neighborKey);
          if (!cell) continue;

          for (const entry of cell) {
            if (entry.segIdx === si) continue;
            if (segToAxis.get(entry.segIdx) === myAxis) continue; // same axis handled above

            const dist = haversineM(coord, entry.coord);
            if (dist <= maxGapM) {
              // Check if this edge already exists (avoid duplicates)
              const existing = edges[si].find((e) => e.to === entry.segIdx);
              if (!existing) {
                edges[si].push({ to: entry.segIdx, cost: dist });
                crossAxisEdges++;
              } else if (dist < existing.cost) {
                existing.cost = dist;
              }
            }
          }
        }
      }
    }
  }

  const elapsed = Date.now() - t0;
  console.log(`[trips] Segment graph: ${segments.length} nodes, ${sameAxisEdges} same-axis edges, ${crossAxisEdges} cross-axis edges (${elapsed}ms)`);

  return { segments, edges, segToAxis, axisSegRanges };
}

// ---------------------------------------------------------------------------
// B. Partial axis usage — convert segment indices to axis chain
// ---------------------------------------------------------------------------

/**
 * Convert a sequence of segment indices into an axis chain suitable for buildRoute().
 *
 * Groups consecutive segments by their axis. For each group, creates a
 * "partial axis" object with only those segments and recalculated totalInfraM.
 */
function segmentsToAxisChain(segIndices, graph, axes) {
  if (segIndices.length === 0) return [];

  const { segments, segToAxis } = graph;
  const groups = [];
  let currentAxisIdx = segToAxis.get(segIndices[0]);
  let currentGroup = [segIndices[0]];

  for (let i = 1; i < segIndices.length; i++) {
    const ai = segToAxis.get(segIndices[i]);
    if (ai === currentAxisIdx) {
      currentGroup.push(segIndices[i]);
    } else {
      groups.push({ axisIdx: currentAxisIdx, segIndices: currentGroup });
      currentAxisIdx = ai;
      currentGroup = [segIndices[i]];
    }
  }
  groups.push({ axisIdx: currentAxisIdx, segIndices: currentGroup });

  // Build partial axis objects
  const chain = [];
  for (const group of groups) {
    const sourceAxis = axes[group.axisIdx];
    const partialSegs = group.segIndices.map((si) => segments[si]);
    const totalInfraM = partialSegs.reduce((s, seg) => s + (seg.lengthM || 0), 0);

    chain.push({
      name: sourceAxis.name,
      slug: sourceAxis.slug,
      segments: partialSegs,
      comunas: sourceAxis.comunas,
      totalInfraM,
      bearing: sourceAxis.bearing,
      avgConditionScore: sourceAxis.avgConditionScore,
      bestCondition: sourceAxis.bestCondition,
      worstCondition: sourceAxis.worstCondition,
      videos: sourceAxis.videos,
      gapsWithinAxis: sourceAxis.gapsWithinAxis,
    });
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Bearing helpers for search
// ---------------------------------------------------------------------------

/** Bearing in degrees (0=N, 90=E) from [lng,lat] to [lng,lat]. */
function bearingDeg(from, to) {
  const dLng = to[0] - from[0];
  const dLat = to[1] - from[1];
  const rad = Math.atan2(dLng, dLat); // atan2(x, y) for bearing
  return ((rad * 180 / Math.PI) + 360) % 360;
}

/** Angular difference in degrees, always 0-180. */
function angleDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

// ---------------------------------------------------------------------------
// C. One-way route search — greedy best-first
// ---------------------------------------------------------------------------

/**
 * Find segments within `radiusM` of a coordinate using the spatial grid.
 */
function findNearbySegments(coord, radiusM, graph) {
  const { segments } = graph;
  const results = [];
  const gridRadius = Math.ceil(radiusM / (GRID_CELL_DEG * 111320)) + 1;
  const cx = Math.floor(coord[0] / GRID_CELL_DEG);
  const cy = Math.floor(coord[1] / GRID_CELL_DEG);

  // Scan cells — but with many segments we just iterate all and filter.
  // For 2255 segments this is fast enough.
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const d = Math.min(
      haversineM(coord, seg.start),
      haversineM(coord, seg.end),
      haversineM(coord, seg.centroid),
    );
    if (d <= radiusM) {
      results.push({ segIdx: si, dist: d });
    }
  }
  return results;
}

/**
 * Search one-way routes from high-scoring anchors using greedy best-first search.
 *
 * For each anchor, finds nearby start segments and runs a direction-constrained
 * search toward distant anchors. The search strongly prefers:
 * 1. Same-axis continuation (follow the bike path you're on)
 * 2. Cross-axis connections that maintain bearing
 * 3. Longer axes over shorter ones
 */
function searchOneWayRoutes(graph, anchors, axes, usableAnchors) {
  const { segments, edges, segToAxis } = graph;
  const candidates = [];
  const highAnchors = anchors.filter((a) => a.anchorScore >= MIN_ANCHOR_SCORE);

  // Build anchor spatial index for quick "is there an anchor near here?" lookups
  const anchorCoords = highAnchors.map((a) => [a.lng, a.lat]);

  /** Find the best anchor within radiusM of a coordinate. */
  function nearestAnchor(coord, radiusM) {
    let best = null, bestDist = radiusM;
    for (let i = 0; i < highAnchors.length; i++) {
      const d = haversineM(coord, anchorCoords[i]);
      if (d < bestDist) { bestDist = d; best = highAnchors[i]; }
    }
    return best;
  }

  let totalSearches = 0;
  let totalFound = 0;

  for (const startAnchor of highAnchors) {
    const startCoord = [startAnchor.lng, startAnchor.lat];
    const nearbyStart = findNearbySegments(startCoord, 2000, graph);
    if (nearbyStart.length === 0) continue;

    // Pick up to 3 start segments (closest, sorted)
    nearbyStart.sort((a, b) => a.dist - b.dist);
    const startSegIndices = nearbyStart.slice(0, 3).map((n) => n.segIdx);

    for (const startSi of startSegIndices) {
      totalSearches++;

      // Greedy best-first search
      // State: { segIdx, path: [segIdx...], infraM, gapM, bearing, visited: Set }
      const startSeg = segments[startSi];
      const initialBearing = bearingDeg(startSeg.start, startSeg.end);

      // Priority queue approximation: just use an array sorted by score
      let frontier = [{
        segIdx: startSi,
        path: [startSi],
        infraM: startSeg.lengthM || 0,
        gapM: 0,
        bearing: initialBearing,
        visited: new Set([startSi]),
        lastCoord: startSeg.end,
      }];

      let steps = 0;
      const routesFromHere = [];

      while (frontier.length > 0 && steps < MAX_SEG_SEARCH_STEPS) {
        // Pop best state (highest infra, maintained direction)
        const state = frontier.shift();
        steps++;

        const totalM = state.infraM + state.gapM;
        const totalKm = totalM / 1000;

        // Check termination: reached an anchor far from start, route long enough
        if (totalKm >= MIN_ROUTE_KM) {
          const endAnchor = nearestAnchor(state.lastCoord, 2000);
          if (endAnchor && endAnchor.name !== startAnchor.name &&
              haversineM(startCoord, [endAnchor.lng, endAnchor.lat]) > 1500) {
            // Build axis chain and validate
            const axisChain = segmentsToAxisChain(state.path, graph, axes);
            if (axisChain.length <= MAX_CHAIN_AXES) {
              const route = buildRoute(axisChain, startAnchor, endAnchor, usableAnchors);
              if (route) {
                routesFromHere.push(route);
                if (routesFromHere.length >= 3) break; // enough from this start
              }
            }
          }
        }

        // Prune: too long
        if (totalKm > MAX_ROUTE_KM) continue;
        if (state.visited.size > 60) continue;

        // Expand neighbors
        const neighborEdges = edges[state.segIdx];
        const expansions = [];

        for (const edge of neighborEdges) {
          if (state.visited.has(edge.to)) continue;

          const nextSeg = segments[edge.to];
          const nextAxis = segToAxis.get(edge.to);
          const currAxis = segToAxis.get(state.segIdx);
          const isSameAxis = nextAxis === currAxis;

          // Direction check for cross-axis transitions
          let bearingToNext = bearingDeg(state.lastCoord, nextSeg.centroid);
          let dirDiff = angleDiff(state.bearing, bearingToNext);

          // Reject reverse direction (>120° turn) for cross-axis
          if (!isSameAxis && dirDiff > 120) continue;

          // Score this expansion
          let score = 0;

          // Strong preference for same-axis continuation
          if (isSameAxis) {
            score += 10;
          } else {
            // Prefer connections that maintain direction
            score += (180 - dirDiff) / 30; // 0-6 based on direction match
            // Prefer longer axes (more infra per gap)
            const nextAxisObj = axes[nextAxis];
            score += Math.min(nextAxisObj.totalInfraM / 3000, 2); // 0-2
            // Penalize gap distance
            score -= edge.cost / 1000; // -0 to -2 for 0-2km gaps
          }

          expansions.push({
            segIdx: edge.to,
            score,
            cost: edge.cost,
            isSameAxis,
            nextSeg,
            bearingToNext,
          });
        }

        // Sort expansions by score, take top candidates
        expansions.sort((a, b) => b.score - a.score);
        const topN = expansions.slice(0, 4);

        for (const exp of topN) {
          const newInfra = state.infraM + (exp.nextSeg.lengthM || 0);
          const newGap = state.gapM + (exp.isSameAxis ? 0 : exp.cost);
          // Update bearing: blend current bearing with new direction
          const newBearing = exp.isSameAxis
            ? bearingDeg(exp.nextSeg.start, exp.nextSeg.end)
            : exp.bearingToNext;

          const newVisited = new Set(state.visited);
          newVisited.add(exp.segIdx);

          frontier.push({
            segIdx: exp.segIdx,
            path: [...state.path, exp.segIdx],
            infraM: newInfra,
            gapM: newGap,
            bearing: newBearing,
            visited: newVisited,
            lastCoord: exp.nextSeg.end,
          });
        }

        // Keep frontier manageable — sort by infra distance (prefer longer routes)
        // and drop states that are too far behind
        if (frontier.length > 50) {
          frontier.sort((a, b) => (b.infraM - b.gapM) - (a.infraM - a.gapM));
          frontier = frontier.slice(0, 30);
        }
      }

      totalFound += routesFromHere.length;
      candidates.push(...routesFromHere);
    }
  }

  console.log(`[trips] One-way search: ${totalSearches} searches, ${totalFound} routes found`);
  return candidates;
}

// ---------------------------------------------------------------------------
// D. Loop route search — outward then curve back
// ---------------------------------------------------------------------------

/**
 * Search loop routes around high-scoring anchors.
 *
 * Strategy: search outward from start, then when distance from start exceeds
 * half the target radius, switch to preferring segments that curve back toward
 * start. This produces oval-ish loops naturally.
 */
function searchLoopRoutes(graph, anchors, axes, usableAnchors) {
  const { segments, edges, segToAxis } = graph;
  const candidates = [];
  const highAnchors = anchors.filter((a) => a.anchorScore >= MIN_ANCHOR_SCORE);

  let totalSearches = 0;
  let totalFound = 0;

  // Try different target radii for different loop sizes
  const targetRadii = [2000, 4000, 6000]; // metres from center

  for (const centerAnchor of highAnchors) {
    const centerCoord = [centerAnchor.lng, centerAnchor.lat];

    for (const targetRadius of targetRadii) {
      const nearbyStart = findNearbySegments(centerCoord, 1500, graph);
      if (nearbyStart.length < MIN_LOOP_SEGS) continue;

      // Pick 2 start segments
      nearbyStart.sort((a, b) => a.dist - b.dist);
      const startSegIndices = nearbyStart.slice(0, 2).map((n) => n.segIdx);

      for (const startSi of startSegIndices) {
        totalSearches++;

        const startSeg = segments[startSi];
        const initialBearing = bearingDeg(startSeg.start, startSeg.end);

        let frontier = [{
          segIdx: startSi,
          path: [startSi],
          infraM: startSeg.lengthM || 0,
          gapM: 0,
          bearing: initialBearing,
          visited: new Set([startSi]),
          lastCoord: startSeg.end,
          phase: 'outward', // 'outward' then 'return'
        }];

        let steps = 0;
        const routesFromHere = [];

        while (frontier.length > 0 && steps < MAX_SEG_SEARCH_STEPS) {
          const state = frontier.shift();
          steps++;

          const totalM = state.infraM + state.gapM;
          const totalKm = totalM / 1000;
          const distFromStart = haversineM(state.lastCoord, centerCoord);

          // Determine phase
          let phase = state.phase;
          if (phase === 'outward' && distFromStart > targetRadius * 0.5) {
            phase = 'return';
          }

          // Check loop closure: near start and route long enough
          if (totalKm >= MIN_ROUTE_KM && state.path.length >= MIN_LOOP_SEGS &&
              phase === 'return' && distFromStart < 2000) {
            const axisChain = segmentsToAxisChain(state.path, graph, axes);
            if (axisChain.length >= 2 && axisChain.length <= MAX_CHAIN_AXES) {
              // Check loop shape before building (quick reject)
              const infraM = axisChain.reduce((s, a) => s + a.totalInfraM, 0);
              const shape = loopShape(axisChain, infraM);
              if (!shape.isPaperclip && !shape.hasHubRevisit) {
                const route = buildRoute(axisChain, centerAnchor, centerAnchor, usableAnchors);
                if (route) {
                  routesFromHere.push(route);
                  if (routesFromHere.length >= 2) break;
                }
              }
            }
          }

          // Prune
          if (totalKm > MAX_ROUTE_KM) continue;
          if (state.visited.size > 60) continue;

          // Expand
          const neighborEdges = edges[state.segIdx];
          const expansions = [];

          for (const edge of neighborEdges) {
            if (state.visited.has(edge.to)) continue;

            const nextSeg = segments[edge.to];
            const nextAxis = segToAxis.get(edge.to);
            const currAxis = segToAxis.get(state.segIdx);
            const isSameAxis = nextAxis === currAxis;

            const bearingToNext = bearingDeg(state.lastCoord, nextSeg.centroid);
            const dirDiff = angleDiff(state.bearing, bearingToNext);

            // For loops, we need to turn — so allow wider bearing tolerance
            // but still reject pure reversals
            if (!isSameAxis && dirDiff > 150) continue;

            let score = 0;

            // Same-axis preference (but less dominant than one-way)
            if (isSameAxis) {
              score += 6;
            } else {
              score += (180 - dirDiff) / 45; // 0-4
              const nextAxisObj = axes[nextAxis];
              score += Math.min(nextAxisObj.totalInfraM / 3000, 2);
              score -= edge.cost / 1000;
            }

            // Phase-dependent scoring
            if (phase === 'outward') {
              // Prefer moving away from start
              const nextDist = haversineM(nextSeg.centroid, centerCoord);
              if (nextDist > distFromStart) score += 2;
            } else {
              // Prefer moving toward start
              const nextDist = haversineM(nextSeg.centroid, centerCoord);
              if (nextDist < distFromStart) score += 3;

              // Bonus for curving — bearing toward start
              const bearingToStart = bearingDeg(state.lastCoord, centerCoord);
              const returnDirDiff = angleDiff(bearingToNext, bearingToStart);
              score += (90 - Math.min(returnDirDiff, 90)) / 30; // 0-3
            }

            expansions.push({
              segIdx: edge.to,
              score,
              cost: edge.cost,
              isSameAxis,
              nextSeg,
              bearingToNext,
              phase,
            });
          }

          expansions.sort((a, b) => b.score - a.score);
          const topN = expansions.slice(0, 4);

          for (const exp of topN) {
            const newInfra = state.infraM + (exp.nextSeg.lengthM || 0);
            const newGap = state.gapM + (exp.isSameAxis ? 0 : exp.cost);
            const newBearing = exp.isSameAxis
              ? bearingDeg(exp.nextSeg.start, exp.nextSeg.end)
              : exp.bearingToNext;

            const newVisited = new Set(state.visited);
            newVisited.add(exp.segIdx);

            frontier.push({
              segIdx: exp.segIdx,
              path: [...state.path, exp.segIdx],
              infraM: newInfra,
              gapM: newGap,
              bearing: newBearing,
              visited: newVisited,
              lastCoord: exp.nextSeg.end,
              phase: exp.phase,
            });
          }

          // Keep frontier manageable
          if (frontier.length > 50) {
            // For loops, sort by combined infra and proximity to closing
            frontier.sort((a, b) => {
              const aScore = a.infraM - a.gapM + (a.phase === 'return' ? 2000 : 0);
              const bScore = b.infraM - b.gapM + (b.phase === 'return' ? 2000 : 0);
              return bScore - aScore;
            });
            frontier = frontier.slice(0, 30);
          }
        }

        totalFound += routesFromHere.length;
        candidates.push(...routesFromHere);
      }
    }
  }

  console.log(`[trips] Loop search: ${totalSearches} searches, ${totalFound} routes found`);
  return candidates;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function stitchTrips(axes, anchors, options = {}) {
  const minAnchorScore = options.minAnchorScore ?? MIN_ANCHOR_SCORE;

  // --- Step 1: Map anchors to nearby axes ---
  const axisAnchors = new Map(); // axis index -> anchors sorted by score

  const usableAnchors = anchors.filter((a) => a.anchorScore >= minAnchorScore);
  console.log(`[trips] ${usableAnchors.length} anchors with score >= ${minAnchorScore}`);

  for (const anchor of usableAnchors) {
    for (let xi = 0; xi < axes.length; xi++) {
      if (anchorToAxisDist(anchor, axes[xi]) <= AXIS_TO_ANCHOR_THRESHOLD_M) {
        if (!axisAnchors.has(xi)) axisAnchors.set(xi, []);
        axisAnchors.get(xi).push(anchor);
      }
    }
  }

  // Sort each axis's anchors by score descending
  for (const [, anchorList] of axisAnchors) {
    anchorList.sort((a, b) => b.anchorScore - a.anchorScore);
  }

  const axesWithAnchors = axisAnchors.size;
  console.log(`[trips] ${axesWithAnchors} axes have nearby anchors`);

  // --- Step 2: Build segment graph ---
  console.log('[trips] Building segment graph...');
  const graph = buildSegmentGraph(axes);

  // --- Step 3: One-way search via greedy best-first ---
  console.log('[trips] Searching one-way routes...');
  const oneWayCandidates = searchOneWayRoutes(graph, anchors, axes, usableAnchors);

  // --- Step 4: Loop search ---
  console.log('[trips] Searching loop routes...');
  const loopCandidates = searchLoopRoutes(graph, anchors, axes, usableAnchors);

  // --- Step 5: Out-and-back for long single axes (preserved from v2) ---
  console.log('[trips] Adding out-and-back routes...');
  const oabCandidates = [];
  for (let xi = 0; xi < axes.length; xi++) {
    const axis = axes[xi];
    if (axis.totalInfraM < MIN_ROUTE_KM * 1000) continue;
    const nearAnchors = axisAnchors.get(xi);
    if (!nearAnchors || nearAnchors.length === 0) continue;

    if (nearAnchors.length >= 2) {
      const oab = buildRoute([axis], nearAnchors[0], nearAnchors[1], usableAnchors);
      if (oab) oabCandidates.push(oab);
    } else {
      const oab = buildRoute([axis], nearAnchors[0], nearAnchors[0], usableAnchors);
      if (oab) oabCandidates.push(oab);
    }
  }
  console.log(`[trips] ${oabCandidates.length} out-and-back candidates`);

  // --- Step 6: Combine and deduplicate ---
  const candidates = [...oneWayCandidates, ...loopCandidates, ...oabCandidates];
  console.log(`[trips] ${candidates.length} total candidates`);

  candidates.sort((a, b) => b.compositeScore - a.compositeScore);

  const kept = [];
  for (const route of candidates) {
    const routeSlugs = new Set(route.axes.map((a) => a.slug));
    let dominated = false;
    for (const existing of kept) {
      const existingSlugs = new Set(existing.axes.map((a) => a.slug));
      let overlap = 0;
      for (const s of routeSlugs) {
        if (existingSlugs.has(s)) overlap++;
      }
      const overlapRatio = overlap / Math.min(routeSlugs.size, existingSlugs.size);
      if (overlapRatio > DEDUP_OVERLAP_THRESHOLD) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      kept.push(route);
    }
  }

  console.log(`[trips] ${kept.length} routes after deduplication`);
  return kept;
}
