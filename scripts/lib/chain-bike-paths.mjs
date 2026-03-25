/**
 * Chain multiple bike paths into one continuous trace.
 *
 * Each bike path is an ordered array of ways. When paths overlap along
 * a corridor, the trace transitions from one path to the next at their
 * nearest connection point — no backtracking, no huge gaps.
 *
 * Algorithm:
 * 1. Start with all ways from the first path
 * 2. For each subsequent path, find the way in the CURRENT trace
 *    closest to the new path, trim the trace there, then append
 *    the new path starting from its nearest way to that point
 */

import { haversineM } from './geo.mjs';

function wayMid(way) {
  const g = way.geometry;
  const mid = Math.floor(g.length / 2);
  return [g[mid].lon, g[mid].lat];
}

/**
 * @param {Array<Array<object>>} pathWays - bike path way arrays (each already ordered)
 * @returns {Array<object>} ordered ways forming one continuous trace
 */
export function chainBikePaths(pathWays) {
  if (pathWays.length === 0) return [];
  if (pathWays.length === 1) return pathWays[0];

  // Start with all ways from the first path
  let trace = [...pathWays[0]];

  for (let p = 1; p < pathWays.length; p++) {
    const nextPath = pathWays[p];
    if (nextPath.length === 0) continue;

    // Find the pair (traceWay, nextWay) with minimum distance.
    // This is where the trace transitions from the current path to the next.
    let bestTracIdx = trace.length - 1;
    let bestNextIdx = 0;
    let bestDist = Infinity;

    for (let t = 0; t < trace.length; t++) {
      const tMid = wayMid(trace[t]);
      for (let n = 0; n < nextPath.length; n++) {
        const nMid = wayMid(nextPath[n]);
        const d = haversineM(tMid, nMid);
        if (d < bestDist) {
          bestDist = d;
          bestTracIdx = t;
          bestNextIdx = n;
        }
      }
    }

    // Trim the current trace at the connection point:
    // keep trace[0..bestTracIdx] (inclusive)
    trace = trace.slice(0, bestTracIdx + 1);

    // Determine direction of the next path: should we go forward
    // (bestNextIdx → end) or backward (bestNextIdx → start)?
    // Pick the direction that moves AWAY from where we already are.
    const connectionMid = wayMid(trace[trace.length - 1]);

    // Check: which end of nextPath is farther from the connection point?
    const startMid = wayMid(nextPath[0]);
    const endMid = wayMid(nextPath[nextPath.length - 1]);
    const dToStart = haversineM(connectionMid, startMid);
    const dToEnd = haversineM(connectionMid, endMid);

    let appendWays;
    if (dToEnd >= dToStart) {
      // End is farther → go forward from bestNextIdx to end
      appendWays = nextPath.slice(bestNextIdx);
    } else {
      // Start is farther → go backward from bestNextIdx to start
      appendWays = nextPath.slice(0, bestNextIdx + 1).reverse();
    }

    // Strip _reversed — buildGPX will orient based on trace continuity
    for (const w of appendWays) {
      const clean = { ...w };
      delete clean._reversed;
      trace.push(clean);
    }
  }

  return trace;
}
