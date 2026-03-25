/**
 * Trace validator — walks a segment chain and rejects routes that
 * retrace their own path or teleport between disconnected areas.
 *
 * Key concept: RETRACING, not backtracking. A zigzag through new
 * interesting areas is fine. Going back to where you already were is not.
 * "Have I been here before?" — not "am I going backwards."
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
 * Retracing detection: "have I been within 200m of this spot before?"
 *
 * Walks the sampled trace. For each point, checks if any EARLIER point
 * (at least 500m back in trace distance) is within the retrace radius.
 * This catches routes that go somewhere and come back, but allows
 * normal curves and small wiggles.
 *
 * Returns the fraction of the route that retraces previously-visited ground.
 * 0.0 = all new territory, 1.0 = completely retracing.
 *
 * @param {Array<[number, number]>} points - sampled trace points
 * @param {number} radiusM - how close counts as "same place" (default 200m)
 * @param {number} minSepM - minimum trace distance before a point can be
 *   considered retracing (prevents flagging normal curves). Default 500m.
 * @returns {{ retracingFraction: number, retracedDistM: number, totalDistM: number }}
 */
function checkRetracing(points, radiusM = 200, minSepM = 500) {
  if (points.length < 5) return { retracingFraction: 0, retracedDistM: 0, totalDistM: 0 };

  // Build cumulative distance array
  const cumDist = [0];
  for (let i = 1; i < points.length; i++) {
    cumDist.push(cumDist[i - 1] + haversineM(points[i - 1], points[i]));
  }
  const totalDistM = cumDist[cumDist.length - 1];

  // Spatial grid for fast "have I been here?" lookups
  const GRID = 0.002; // ~200m cells
  const visited = new Map(); // gridKey → [{ pointIdx, cumDist }]

  let retracedDist = 0;

  for (let i = 0; i < points.length; i++) {
    const [lng, lat] = points[i];
    const gx = Math.floor(lng / GRID);
    const gy = Math.floor(lat / GRID);
    const key = `${gx},${gy}`;

    // Check if any earlier point (far enough back in trace distance) is nearby
    let isRetracing = false;
    outer:
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighborKey = `${gx + dx},${gy + dy}`;
        const cell = visited.get(neighborKey);
        if (!cell) continue;
        for (const prev of cell) {
          // Must be at least minSepM back along the trace
          if (cumDist[i] - prev.cumDist < minSepM) continue;
          if (haversineM(points[i], points[prev.pointIdx]) < radiusM) {
            isRetracing = true;
            break outer;
          }
        }
      }
    }

    if (isRetracing && i > 0) {
      retracedDist += haversineM(points[i - 1], points[i]);
    }

    // Add to spatial grid
    if (!visited.has(key)) visited.set(key, []);
    visited.get(key).push({ pointIdx: i, cumDist: cumDist[i] });
  }

  const retracingFraction = totalDistM > 0 ? retracedDist / totalDistM : 0;
  return {
    retracingFraction: Math.round(retracingFraction * 100) / 100,
    retracedDistM: Math.round(retracedDist),
    totalDistM: Math.round(totalDistM),
  };
}

/**
 * Validate a segment chain for trace quality.
 *
 * Checks ALL archetypes (including mountain) for retracing.
 * A route that visits the same place twice is bad regardless of archetype.
 *
 * @param {Array} segments - ordered segments with .start, .end, .geometry, .lengthM
 * @param {string} archetype - 'one-way', 'loop', or 'mountain'
 * @param {object} [opts]
 * @param {number} [opts.maxGapM=3000] - max gap between consecutive segments
 * @param {number} [opts.maxRetracingFraction=0.15] - max fraction of route that retraces
 * @returns {{ valid: boolean, reason?: string, worstGapM: number, retracingFraction: number, retracedDistM: number }}
 */
export function validateTrace(segments, archetype, opts = {}) {
  const maxGapM = opts.maxGapM ?? 3000;
  const maxRetracing = opts.maxRetracingFraction ?? 0.15;

  if (!segments || segments.length === 0) {
    return { valid: false, reason: 'no segments', worstGapM: 0, retracingFraction: 1, retracedDistM: 0 };
  }

  // 1. Teleporting check (all archetypes)
  const { worst: worstGapM, teleports } = checkTeleporting(segments, maxGapM);
  if (teleports > 0) {
    return {
      valid: false,
      reason: `teleport: ${teleports} gap(s) > ${maxGapM}m (worst: ${Math.round(worstGapM)}m)`,
      worstGapM, retracingFraction: 0, retracedDistM: 0,
    };
  }

  // 2. Retracing check (ALL archetypes — no exemptions)
  const points = sampleTracePoints(segments);
  const { retracingFraction, retracedDistM, totalDistM } = checkRetracing(points);

  if (retracingFraction > maxRetracing) {
    return {
      valid: false,
      reason: `retracing: ${Math.round(retracingFraction * 100)}% of route revisits same area (${(retracedDistM / 1000).toFixed(1)}km of ${(totalDistM / 1000).toFixed(1)}km)`,
      worstGapM, retracingFraction, retracedDistM,
    };
  }

  return { valid: true, worstGapM, retracingFraction, retracedDistM };
}
