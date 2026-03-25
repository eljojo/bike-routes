/**
 * Trace validator — walks a segment chain and rejects routes with
 * teleporting, backtracking, or zigzag traces.
 *
 * All coordinates are [lng, lat] (GeoJSON order).
 */

import { haversineM } from './geo.mjs';

/**
 * Walk geometry coordinates of all segments, emitting a point every
 * `intervalM` metres along the actual trace.
 * @returns {Array<[number, number]>} sampled [lng, lat] points
 */
function sampleTracePoints(segments, intervalM = 200) {
  const points = [];
  let carry = 0; // distance accumulated since last emitted point

  for (const seg of segments) {
    const coords =
      seg.geometry.type === 'MultiLineString'
        ? seg.geometry.coordinates.flat()
        : seg.geometry.coordinates;

    for (let i = 0; i < coords.length; i++) {
      const pt = [coords[i][0], coords[i][1]];
      if (i === 0 && points.length === 0) {
        points.push(pt);
        carry = 0;
        continue;
      }
      if (i === 0) continue; // skip duplicate start of new segment

      const prev = coords[i - 1];
      const prevPt = [prev[0], prev[1]];
      const d = haversineM(prevPt, pt);
      carry += d;

      while (carry >= intervalM) {
        // Interpolate back from current point
        const overshoot = carry - intervalM;
        const frac = d > 0 ? overshoot / d : 0;
        const emitted = [
          pt[0] + (prevPt[0] - pt[0]) * frac,
          pt[1] + (prevPt[1] - pt[1]) * frac,
        ];
        points.push(emitted);
        carry = overshoot;
        // Only emit once per sub-step to avoid infinite loop on tiny d
        if (d < 1) break;
      }
    }
  }
  return points;
}

/**
 * Detect teleporting: walk consecutive segments and find the minimum gap
 * between segment[i].end and segment[i+1].start (checking both orientations).
 * @returns {{ worst: number, teleports: number }}
 */
function checkTeleporting(segments, maxGapM) {
  let worst = 0;
  let teleports = 0;

  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i];
    const b = segments[i + 1];
    // Check all four endpoint combos, take the minimum
    const gap = Math.min(
      haversineM(a.end, b.start),
      haversineM(a.end, b.end),
      haversineM(a.start, b.start),
      haversineM(a.start, b.end),
    );
    if (gap > worst) worst = gap;
    if (gap > maxGapM) teleports++;
  }
  return { worst, teleports };
}

/**
 * Backtracking detection for one-way routes.
 * Projects sampled points onto the start→end direction vector.
 * A drop of more than maxBacktrackM from the running max means backtracking.
 */
function checkOneWayBacktracking(segments, maxBacktrackM) {
  const points = sampleTracePoints(segments);
  if (points.length < 3) return 0;

  const first = points[0];
  const last = points[points.length - 1];

  // Direction vector (in degrees, good enough for projection at city scale)
  const dx = last[0] - first[0];
  const dy = last[1] - first[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) return 0; // degenerate route

  let maxProj = -Infinity;
  let backtrackCount = 0;

  for (const pt of points) {
    const px = pt[0] - first[0];
    const py = pt[1] - first[1];
    const proj = (px * dx + py * dy) / Math.sqrt(lenSq);
    // Convert projection from degrees to approximate metres
    const projM = proj * 111_320;

    if (projM > maxProj) maxProj = projM;
    if (maxProj - projM > maxBacktrackM) backtrackCount++;
  }
  return backtrackCount;
}

/**
 * Backtracking detection for loop routes.
 * Computes angle from route centroid to each sampled point.
 * Counts significant direction reversals (>15 degrees of arc each).
 */
function checkLoopBacktracking(segments) {
  const points = sampleTracePoints(segments);
  if (points.length < 5) return 0;

  // Compute centroid of all sampled points
  let cx = 0, cy = 0;
  for (const [x, y] of points) { cx += x; cy += y; }
  cx /= points.length;
  cy /= points.length;

  // Compute angles from centroid
  const angles = points.map(([x, y]) => Math.atan2(y - cy, x - cx) * (180 / Math.PI));

  // Determine initial direction (CW or CCW)
  let reversals = 0;
  let currentDir = 0; // +1 = increasing angle, -1 = decreasing
  let arcSinceReversal = 0;
  const MIN_ARC = 15; // degrees

  for (let i = 1; i < angles.length; i++) {
    let delta = angles[i] - angles[i - 1];
    // Normalize to [-180, 180]
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    if (Math.abs(delta) < 0.5) continue; // skip negligible movement

    const dir = delta > 0 ? 1 : -1;
    if (currentDir === 0) {
      currentDir = dir;
      arcSinceReversal = Math.abs(delta);
    } else if (dir === currentDir) {
      arcSinceReversal += Math.abs(delta);
    } else {
      // Direction changed — only count if previous arc was significant
      if (arcSinceReversal > MIN_ARC) {
        reversals++;
      }
      currentDir = dir;
      arcSinceReversal = Math.abs(delta);
    }
  }
  return reversals;
}

/**
 * Validate a segment chain for trace quality.
 * @param {Array} segments - ordered segments with .start, .end, .geometry, .lengthM
 * @param {string} archetype - 'one-way', 'loop', or 'mountain'
 * @param {object} [opts] - { maxGapM: 3000, maxBacktrackM: 500 }
 * @returns {{ valid: boolean, reason?: string, worstGapM: number, backtrackCount: number }}
 */
export function validateTrace(segments, archetype, opts = {}) {
  const maxGapM = opts.maxGapM ?? 3000;
  const maxBacktrackM = opts.maxBacktrackM ?? 500;

  if (!segments || segments.length === 0) {
    return { valid: false, reason: 'no segments', worstGapM: 0, backtrackCount: 0 };
  }

  // 1. Teleporting check (all archetypes)
  const { worst: worstGapM, teleports } = checkTeleporting(segments, maxGapM);
  if (teleports > 0) {
    return { valid: false, reason: `teleport: ${teleports} gap(s) > ${maxGapM}m (worst: ${Math.round(worstGapM)}m)`, worstGapM, backtrackCount: 0 };
  }

  // 2. Mountain routes — skip backtracking checks
  if (archetype === 'mountain') {
    return { valid: true, worstGapM, backtrackCount: 0 };
  }

  // 3. Backtracking check
  let backtrackCount = 0;
  if (archetype === 'loop') {
    backtrackCount = checkLoopBacktracking(segments);
    if (backtrackCount > 2) {
      return { valid: false, reason: `loop zigzag: ${backtrackCount} direction reversals`, worstGapM, backtrackCount };
    }
  } else {
    // one-way or any other archetype
    backtrackCount = checkOneWayBacktracking(segments, maxBacktrackM);
    if (backtrackCount > 0) {
      return { valid: false, reason: `backtracking: ${backtrackCount} point(s) regressed > ${maxBacktrackM}m`, worstGapM, backtrackCount };
    }
  }

  return { valid: true, worstGapM, backtrackCount };
}
