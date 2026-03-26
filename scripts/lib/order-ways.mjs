/**
 * Order OSM ways into a continuous trace using endpoint graph traversal.
 *
 * Algorithm:
 * 1. Compute geometric length per way
 * 2. Cluster nearby endpoints into junctions (direct distance, no transitive chain)
 * 3. Drop self-loops and tiny fragments
 * 4. Dedup: same cluster pair + similar geometry → keep longest by metres
 * 5. Build adjacency graph, find connected components
 * 6. Walk each component from terminus, preferring straight continuation at junctions
 * 7. Return ways with _reversed flag so buildGPX doesn't re-guess orientation
 */

import { haversineM } from './geo.mjs';

const SNAP_M = 40; // slightly tighter than 50m to avoid merging distinct junctions

// ---------------------------------------------------------------------------
// Geometric length of a way in metres
// ---------------------------------------------------------------------------

function wayLengthM(way) {
  let len = 0;
  for (let j = 1; j < way.geometry.length; j++) {
    len += haversineM(
      [way.geometry[j - 1].lon, way.geometry[j - 1].lat],
      [way.geometry[j].lon, way.geometry[j].lat],
    );
  }
  return len;
}

// ---------------------------------------------------------------------------
// Bearing from coord A to coord B in radians
// ---------------------------------------------------------------------------

function bearing(a, b) {
  return Math.atan2(b[0] - a[0], b[1] - a[1]);
}

function angleDiff(a, b) {
  let d = Math.abs(a - b);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/**
 * @param {Array<{id: number, geometry: Array<{lon: number, lat: number}>}>} ways
 * @returns {Array} ordered ways (with _reversed: boolean added)
 */
export function orderWays(ways) {
  if (ways.length === 0) return ways;

  // --- Precompute per-way data ---
  const segs = ways.map((way, i) => {
    const g = way.geometry;
    const start = [g[0].lon, g[0].lat];
    const end = [g[g.length - 1].lon, g[g.length - 1].lat];
    return {
      i, way, start, end,
      mid: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
      lengthM: wayLengthM(way),
    };
  });

  // --- Cluster endpoints (fix #4: direct distance only, no transitive chain) ---
  // Instead of union-find which creates transitive chains (A↔B↔C merges A+C
  // even if A-C > SNAP_M), use a greedy approach: each endpoint joins the
  // nearest existing cluster within SNAP_M, or starts a new cluster.
  const allEps = segs.flatMap(s => [s.start, s.end]);
  const epCluster = new Array(allEps.length).fill(-1);
  const clusters = []; // [{coord: [lng, lat], members: [epIdx...]}]

  for (let i = 0; i < allEps.length; i++) {
    let bestCl = -1, bestD = SNAP_M;
    for (let c = 0; c < clusters.length; c++) {
      const d = haversineM(allEps[i], clusters[c].coord);
      if (d < bestD) { bestD = d; bestCl = c; }
    }
    if (bestCl >= 0) {
      epCluster[i] = bestCl;
      // Update cluster centroid
      const cl = clusters[bestCl];
      cl.members.push(i);
      cl.coord = [
        cl.members.reduce((s, j) => s + allEps[j][0], 0) / cl.members.length,
        cl.members.reduce((s, j) => s + allEps[j][1], 0) / cl.members.length,
      ];
    } else {
      epCluster[i] = clusters.length;
      clusters.push({ coord: [...allEps[i]], members: [i] });
    }
  }

  for (const seg of segs) {
    seg.startCluster = epCluster[seg.i * 2];
    seg.endCluster = epCluster[seg.i * 2 + 1];
  }

  // --- Dedup (fixes #1 and #2) ---
  const dropped = new Set();

  // Drop self-loops
  for (const seg of segs) {
    if (seg.startCluster === seg.endCluster) dropped.add(seg.i);
  }

  // Drop tiny fragments
  for (const seg of segs) {
    if (seg.lengthM < SNAP_M) dropped.add(seg.i);
  }

  // Same-cluster-pair dedup: if multiple ways connect the same two
  // clusters, keep only the longest by metres
  const byPair = new Map();
  for (const seg of segs) {
    if (dropped.has(seg.i)) continue;
    const a = Math.min(seg.startCluster, seg.endCluster);
    const b = Math.max(seg.startCluster, seg.endCluster);
    const key = `${a}:${b}`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(seg);
  }
  for (const group of byPair.values()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => b.lengthM - a.lengthM);
    const kept = [group[0]];
    for (let k = 1; k < group.length; k++) {
      if (kept.some(o => haversineM(group[k].mid, o.mid) < 80)) {
        dropped.add(group[k].i);
      } else {
        kept.push(group[k]);
      }
    }
  }

  // Oneway lane dedup: if two ways both have oneway tags and are within
  // 30m perpendicular distance with similar or anti-parallel bearing,
  // they're parallel lanes of the same bike path. Keep the longer one.
  // This catches bidirectional cycleways mapped as two one-way lanes.
  {
    const remaining = segs.filter(s => !dropped.has(s.i));
    remaining.sort((a, b) => b.lengthM - a.lengthM);
    for (let i = 0; i < remaining.length; i++) {
      if (dropped.has(remaining[i].i)) continue;
      const a = remaining[i];
      const aOneway = a.way.tags?.oneway === 'yes' || a.way.tags?.['oneway:bicycle'] === 'yes';
      if (!aOneway) continue;
      const aB = bearing(a.start, a.end);

      for (let j = i + 1; j < remaining.length; j++) {
        if (dropped.has(remaining[j].i)) continue;
        const b = remaining[j];
        const bOneway = b.way.tags?.oneway === 'yes' || b.way.tags?.['oneway:bicycle'] === 'yes';
        if (!bOneway) continue;

        if (haversineM(a.mid, b.mid) > 100) continue;

        const bB = bearing(b.start, b.end);
        let bDiff = angleDiff(aB, bB);
        const antiDiff = angleDiff(aB, bB + Math.PI);
        if (Math.min(bDiff, antiDiff) > Math.PI / 4) continue; // > 45°

        // Perpendicular distance
        const axDir = [Math.cos(aB), Math.sin(aB)];
        const perpDir = [-axDir[1], axDir[0]];
        const perpDist = Math.abs((b.mid[0] - a.mid[0]) * perpDir[0] + (b.mid[1] - a.mid[1]) * perpDir[1]) * 100000;
        if (perpDist > 50) continue;

        dropped.add(b.i);
      }
    }
  }

  // Parallel-overlap dedup: detect ways that cover the same corridor
  // but are in DIFFERENT clusters (e.g. 100m apart along a river).
  // Two ways are parallel overlaps if:
  //   - similar bearing (within 30°)
  //   - their along-axis projections overlap by > 50%
  //   - perpendicular distance < 150m
  const remaining = segs.filter(s => !dropped.has(s.i));
  remaining.sort((a, b) => b.lengthM - a.lengthM); // process longest first

  for (let i = 0; i < remaining.length; i++) {
    if (dropped.has(remaining[i].i)) continue;
    const a = remaining[i];
    const aB = bearing(a.start, a.end);

    for (let j = i + 1; j < remaining.length; j++) {
      if (dropped.has(remaining[j].i)) continue;
      const b = remaining[j];

      // Quick distance filter — midpoints must be within 200m
      if (haversineM(a.mid, b.mid) > 200) continue;

      // Similar bearing?
      const bB = bearing(b.start, b.end);
      let bDiff = angleDiff(aB, bB);
      // Also check anti-parallel (same corridor, opposite direction)
      const antiDiff = angleDiff(aB, bB + Math.PI);
      bDiff = Math.min(bDiff, antiDiff);
      if (bDiff > Math.PI / 6) continue; // > 30°

      // Project both ways onto their shared axis direction.
      // Check if their 1D extents overlap.
      const axDir = [Math.cos(aB), Math.sin(aB)];
      const projA1 = a.start[0] * axDir[0] + a.start[1] * axDir[1];
      const projA2 = a.end[0] * axDir[0] + a.end[1] * axDir[1];
      const projB1 = b.start[0] * axDir[0] + b.start[1] * axDir[1];
      const projB2 = b.end[0] * axDir[0] + b.end[1] * axDir[1];
      const aMin = Math.min(projA1, projA2), aMax = Math.max(projA1, projA2);
      const bMin = Math.min(projB1, projB2), bMax = Math.max(projB1, projB2);
      const overlap = Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
      const bSpan = bMax - bMin;
      if (bSpan > 0 && overlap / bSpan < 0.5) continue; // <50% overlap

      // Perpendicular distance: distance from b's midpoint to line through a
      const perpDir = [-axDir[1], axDir[0]]; // 90° rotation
      const perpDist = Math.abs((b.mid[0] - a.mid[0]) * perpDir[0] + (b.mid[1] - a.mid[1]) * perpDir[1]);
      // Convert from degrees to rough metres
      const perpDistM = perpDist * 100000; // ~1° ≈ 100km
      if (perpDistM > 150) continue;

      // b is a parallel overlap of a — drop the shorter one (b, since sorted)
      dropped.add(b.i);
    }
  }

  const active = segs.filter(s => !dropped.has(s.i));
  if (active.length === 0) return [];

  // --- Build adjacency ---
  const segMap = new Map(active.map(s => [s.i, s]));
  const adj = new Map();
  for (const seg of active) {
    if (!adj.has(seg.startCluster)) adj.set(seg.startCluster, []);
    if (!adj.has(seg.endCluster)) adj.set(seg.endCluster, []);
    adj.get(seg.startCluster).push(seg.i);
    adj.get(seg.endCluster).push(seg.i);
  }

  function clusterCoord(cid) {
    return clusters[cid]?.coord || [0, 0];
  }

  // --- Connected components ---
  const seen = new Set();
  const components = [];
  for (const seg of active) {
    if (seen.has(seg.i)) continue;
    const comp = [];
    const stack = [seg.i];
    while (stack.length) {
      const si = stack.pop();
      if (seen.has(si)) continue;
      seen.add(si);
      comp.push(si);
      const s = segMap.get(si);
      for (const cl of [s.startCluster, s.endCluster]) {
        for (const ni of adj.get(cl) || []) if (!seen.has(ni)) stack.push(ni);
      }
    }
    components.push(comp);
  }

  // --- Walk (fixes #3 and #5) ---
  // Fix #3: at junctions, prefer edge with smallest turn angle from current heading
  // Fix #5: track orientation, return {way, _reversed} so buildGPX doesn't re-guess

  function doWalk(segIds, startV) {
    const unused = new Set(segIds);
    let cur = startV;
    let lastBearing = null; // track heading for direction-aware junction choice
    const result = [];

    while (unused.size > 0) {
      const incident = (adj.get(cur) || []).filter(si => unused.has(si));

      if (incident.length === 0) {
        // Dead end — jump to nearest unused cluster
        let bestCl = null, bestD = Infinity;
        const cc = clusterCoord(cur);
        for (const si of unused) {
          const s = segMap.get(si);
          for (const cl of [s.startCluster, s.endCluster]) {
            const d = haversineM(cc, clusterCoord(cl));
            if (d < bestD) { bestD = d; bestCl = cl; }
          }
        }
        cur = bestCl;
        lastBearing = null; // lost heading after jump
        continue;
      }

      // Filter by oneway direction: if a way has oneway=yes, only enter
      // it from its start cluster (following the one-way direction).
      // Don't enter from its end cluster (going against traffic).
      const directed = incident.filter(si => {
        const s = segMap.get(si);
        const oneway = s.way.tags?.oneway === 'yes' || s.way.tags?.['oneway:bicycle'] === 'yes';
        if (!oneway) return true; // not oneway, either direction fine
        // For oneway, cur must be the start cluster (entering from start)
        return s.startCluster === cur;
      });
      // Fall back to all incident if oneway filtering removes everything
      const candidates = directed.length > 0 ? directed : incident;

      // Fix #3: pick the edge with smallest turn angle from current heading
      let nextSi;
      if (candidates.length === 1 || lastBearing === null) {
        nextSi = candidates[0];
      } else {
        let bestTurn = Infinity;
        nextSi = candidates[0];
        for (const si of candidates) {
          const s = segMap.get(si);
          const otherCluster = s.startCluster === cur ? s.endCluster : s.startCluster;
          const edgeBearing = bearing(clusterCoord(cur), clusterCoord(otherCluster));
          const turn = angleDiff(lastBearing, edgeBearing);
          if (turn < bestTurn) { bestTurn = turn; nextSi = si; }
        }
      }

      unused.delete(nextSi);
      const seg = segMap.get(nextSi);

      // Determine traversal direction: enter from cur cluster
      const reversed = seg.endCluster === cur;
      const entryCoord = reversed ? seg.end : seg.start;
      const exitCoord = reversed ? seg.start : seg.end;

      // Fix #5: attach _reversed flag to the way
      result.push({ ...seg.way, _reversed: reversed });

      // Update heading
      lastBearing = bearing(entryCoord, exitCoord);

      // Move to exit cluster
      cur = seg.startCluster === cur ? seg.endCluster : seg.startCluster;
    }
    return result;
  }

  function countReversals(orderedWays) {
    let revs = 0, lastB = null;
    for (const w of orderedWays) {
      const coords = w.geometry.map(p => [p.lon, p.lat]);
      const trace = w._reversed ? [...coords].reverse() : coords;
      if (trace.length >= 2) {
        const b = bearing(trace[0], trace[trace.length - 1]);
        if (lastB !== null && angleDiff(lastB, b) > 2 * Math.PI / 3) revs++;
        lastB = b;
      }
    }
    return revs;
  }

  function firstReversalIndex(orderedWays) {
    let lastB = null;
    for (let k = 0; k < orderedWays.length; k++) {
      const w = orderedWays[k];
      const coords = w.geometry.map(p => [p.lon, p.lat]);
      const trace = w._reversed ? [...coords].reverse() : coords;
      if (trace.length >= 2) {
        const b = bearing(trace[0], trace[trace.length - 1]);
        if (lastB !== null && angleDiff(lastB, b) > 2 * Math.PI / 3) return k;
        lastB = b;
      }
    }
    return orderedWays.length;
  }

  function walkComponent(segIds) {
    const deg = new Map();
    for (const si of segIds) {
      const s = segMap.get(si);
      deg.set(s.startCluster, (deg.get(s.startCluster) || 0) + 1);
      deg.set(s.endCluster, (deg.get(s.endCluster) || 0) + 1);
    }
    const odd = [...deg.entries()].filter(([, d]) => d % 2 === 1).map(([v]) => v);
    const candidates = odd.length >= 2 ? odd : [[...deg.entries()].sort((a, b) => a[1] - b[1])[0][0]];

    // Try each start, optionally reversing to enforce direction convention.
    // Convention: W→E for east-west paths, N→S for north-south paths.
    function enforceDirection(ways) {
      if (ways.length === 0) return ways;
      const first = ways[0], last = ways[ways.length - 1];
      const fC = first.geometry.map(p => [p.lon, p.lat]);
      const lC = last.geometry.map(p => [p.lon, p.lat]);
      const fT = first._reversed ? [...fC].reverse() : fC;
      const lT = last._reversed ? [...lC].reverse() : lC;
      const s = fT[0], e = lT[lT.length - 1];
      const dlng = e[0] - s[0], dlat = e[1] - s[1];
      // Use bearing to determine if path is E-W or N-S.
      // Bearing 45-135° or 225-315° = primarily E-W.
      // Otherwise primarily N-S.
      const b = (Math.atan2(dlng, dlat) * 180 / Math.PI + 360) % 360;
      const isEW = (b >= 45 && b < 135) || (b >= 225 && b < 315);
      const wrong = isEW ? dlng < 0 : dlat > 0;
      if (!wrong) return ways;
      const rev = [...ways].reverse();
      for (const w of rev) w._reversed = !w._reversed;
      return rev;
    }

    let bestResult = null, bestRevs = Infinity, bestFirstRev = 0;
    for (const startV of candidates) {
      const result = enforceDirection(doWalk(segIds, startV));
      const revs = countReversals(result);
      const fr = firstReversalIndex(result);
      if (revs < bestRevs || (revs === bestRevs && fr > bestFirstRev)) {
        bestRevs = revs; bestResult = result; bestFirstRev = fr;
      }
    }
    return bestResult;
  }

  // --- Walk components, stitch by nearest endpoints ---
  const walked = components.map(comp => {
    const ordered = walkComponent(comp);
    if (ordered.length === 0) return null;
    const first = ordered[0], last = ordered[ordered.length - 1];
    const fCoords = first.geometry.map(p => [p.lon, p.lat]);
    const lCoords = last.geometry.map(p => [p.lon, p.lat]);
    const fTrace = first._reversed ? [...fCoords].reverse() : fCoords;
    const lTrace = last._reversed ? [...lCoords].reverse() : lCoords;
    return {
      ways: ordered,
      start: fTrace[0],
      end: lTrace[lTrace.length - 1],
    };
  }).filter(Boolean);

  walked.sort((a, b) => b.ways.length - a.ways.length);
  const chain = [walked[0]];
  const rest = walked.slice(1);
  while (rest.length > 0) {
    const options = [];
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      const tail = chain[chain.length - 1];
      const head = chain[0];
      options.push(
        { d: haversineM(tail.end, c.start), place: 'append', rev: false, i },
        { d: haversineM(tail.end, c.end), place: 'append', rev: true, i },
        { d: haversineM(c.end, head.start), place: 'prepend', rev: false, i },
        { d: haversineM(c.start, head.start), place: 'prepend', rev: true, i },
      );
    }
    options.sort((a, b) => a.d - b.d);
    const minDist = options[0].d;
    // Among options within 50% of minimum distance, prefer the one that
    // doesn't create a bearing reversal at the junction.
    const threshold = Math.max(minDist * 1.5, minDist + 500);
    const viable = options.filter(o => o.d <= threshold);

    // Tiered selection: preserve component orientation by default.
    // 1. Try append + non-reversing first (safest — keeps enforceDirection)
    // 2. Among those, prefer turn < 90° if available, else nearest distance
    // 3. Only fall back to prepend or reversing if no acceptable append exists
    const tail = chain[chain.length - 1];
    const tailFwd = bearing(tail.start, tail.end);

    // Tier 1: append + rev:false
    const tier1 = viable.filter(o => o.place === 'append' && !o.rev);
    // Tier 2: append + rev:true
    const tier2 = viable.filter(o => o.place === 'append' && o.rev);
    // Tier 3: prepend (any)
    const tier3 = viable.filter(o => o.place === 'prepend');

    let best = viable[0]; // ultimate fallback
    let found = false;

    for (const tier of [tier1, tier2, tier3]) {
      if (found || tier.length === 0) continue;
      // Within this tier, check bearing continuity
      let bearingMatch = null;
      for (const opt of tier) {
        const c = rest[opt.i];
        const cEntry = opt.rev ? c.end : c.start;
        const cExit = opt.rev ? c.start : c.end;
        const continueFwd = bearing(cEntry, cExit);
        const turn = angleDiff(tailFwd, continueFwd);
        if (turn < Math.PI / 2) { bearingMatch = opt; break; }
      }
      // If a bearing match exists in this tier, use it. Otherwise use
      // the nearest distance in this tier.
      best = bearingMatch || tier[0];
      found = true;
    }

    const comp = rest.splice(best.i, 1)[0];
    const norm = best.rev
      ? {
          ways: [...comp.ways].reverse().map(w => ({ ...w, _reversed: !w._reversed })),
          start: comp.end,
          end: comp.start,
        }
      : comp;
    if (best.place === 'append') chain.push(norm);
    else chain.unshift(norm);
  }

  const result = chain.flatMap(c => c.ways);

  // Re-enforce direction on the final stitched result.
  // Per-component enforcement runs inside walkComponent, but stitching
  // can reorder/reverse components, and per-component bearings may differ
  // from the overall bearing. This final check catches those cases.
  // Proven by: Pocuro diagnostic test (overall E-W going west, unfixed).
  if (result.length >= 1) {
    const first = result[0], last = result[result.length - 1];
    const fC = first.geometry.map(p => [p.lon, p.lat]);
    const lC = last.geometry.map(p => [p.lon, p.lat]);
    const fT = first._reversed ? [...fC].reverse() : fC;
    const lT = last._reversed ? [...lC].reverse() : lC;
    const s = fT[0], e = lT[lT.length - 1];
    const dlng = e[0] - s[0], dlat = e[1] - s[1];
    const b = (Math.atan2(dlng, dlat) * 180 / Math.PI + 360) % 360;
    const isEW = (b >= 45 && b < 135) || (b >= 225 && b < 315);
    const wrong = isEW ? dlng < 0 : dlat > 0;
    if (wrong) {
      result.reverse();
      for (const w of result) w._reversed = !w._reversed;
    }
  }

  return result;
}
