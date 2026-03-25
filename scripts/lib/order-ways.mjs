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
  if (ways.length <= 1) return ways;

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

  // Fix #1: sort by geometric length in metres, not point count
  // Fix #2: only dedup ways with similar midpoints (true overlaps),
  // not all same-cluster-pair edges
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
    group.sort((a, b) => b.lengthM - a.lengthM); // longest by metres first
    const kept = [group[0]];
    for (let k = 1; k < group.length; k++) {
      // Only drop if midpoints are within 80m (true geometric overlap)
      if (kept.some(o => haversineM(group[k].mid, o.mid) < 80)) {
        dropped.add(group[k].i);
      } else {
        kept.push(group[k]); // legitimate parallel segment, keep it
      }
    }
  }

  const active = segs.filter(s => !dropped.has(s.i));
  if (active.length <= 1) return active.map(s => s.way);

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

      // Fix #3: pick the edge with smallest turn angle from current heading
      let nextSi;
      if (incident.length === 1 || lastBearing === null) {
        nextSi = incident[0];
      } else {
        let bestTurn = Infinity;
        nextSi = incident[0];
        for (const si of incident) {
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

    let bestResult = null, bestRevs = Infinity, bestFirstRev = 0;
    for (const startV of candidates) {
      const result = doWalk(segIds, startV);
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
  if (walked.length === 1) return walked[0].ways;

  const chain = [walked[0]];
  const rest = walked.slice(1);
  while (rest.length > 0) {
    let best = null;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      const tail = chain[chain.length - 1];
      const head = chain[0];
      for (const opt of [
        { d: haversineM(tail.end, c.start), place: 'append', rev: false, i },
        { d: haversineM(tail.end, c.end), place: 'append', rev: true, i },
        { d: haversineM(c.end, head.start), place: 'prepend', rev: false, i },
        { d: haversineM(c.start, head.start), place: 'prepend', rev: true, i },
      ]) {
        if (!best || opt.d < best.d) best = opt;
      }
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

  return chain.flatMap(c => c.ways);
}
