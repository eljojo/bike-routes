/**
 * Order OSM ways into a continuous trace using endpoint graph traversal.
 *
 * Each way has a start and end point. Connected ways share endpoints
 * (within ~50m). This is a graph traversal problem:
 * - Cluster nearby endpoints into junctions
 * - Each way is an edge connecting two junctions
 * - Walk from one terminus to the other
 *
 * For a linear bike path, there are exactly 2 junctions with degree 1
 * (the termini). The ordered trace is an Euler trail.
 */

import { haversineM } from './geo.mjs';

const SNAP_M = 50;

/**
 * @param {Array<{id: number, geometry: Array<{lon: number, lat: number}>}>} ways
 * @returns {Array} ordered ways
 */
export function orderWays(ways) {
  if (ways.length <= 1) return ways;

  // Extract endpoints
  const segs = ways.map((way, i) => {
    const g = way.geometry;
    return {
      i,
      way,
      start: [g[0].lon, g[0].lat],
      end: [g[g.length - 1].lon, g[g.length - 1].lat],
      mid: [(g[0].lon + g[g.length - 1].lon) / 2, (g[0].lat + g[g.length - 1].lat) / 2],
    };
  });

  // --- Cluster endpoints within SNAP_M ---
  // All endpoints in a flat array: [seg0.start, seg0.end, seg1.start, seg1.end, ...]
  const allEps = segs.flatMap(s => [s.start, s.end]);
  const parent = allEps.map((_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; }

  for (let i = 0; i < allEps.length; i++) {
    for (let j = i + 1; j < allEps.length; j++) {
      if (haversineM(allEps[i], allEps[j]) <= SNAP_M) union(i, j);
    }
  }

  // Assign cluster IDs
  const rootToCluster = new Map();
  let nextCluster = 0;
  function clusterId(epIdx) {
    const root = find(epIdx);
    if (!rootToCluster.has(root)) rootToCluster.set(root, nextCluster++);
    return rootToCluster.get(root);
  }

  for (const seg of segs) {
    seg.startCluster = clusterId(seg.i * 2);
    seg.endCluster = clusterId(seg.i * 2 + 1);
  }

  // --- Dedup ---
  const dropped = new Set();

  // Drop self-loops (start and end in same cluster) — these are noise
  for (const seg of segs) {
    if (seg.startCluster === seg.endCluster) dropped.add(seg.i);
  }

  // Drop ways shorter than snap distance — OSM fragments
  for (const seg of segs) {
    let len = 0;
    const g = seg.way.geometry;
    for (let j = 1; j < g.length; j++) len += haversineM([g[j - 1].lon, g[j - 1].lat], [g[j].lon, g[j].lat]);
    if (len < SNAP_M) dropped.add(seg.i);
  }

  // Group by cluster pair — if multiple ways connect the same two
  // clusters, keep only the longest
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
    group.sort((a, b) => b.way.geometry.length - a.way.geometry.length);
    // Keep the longest, drop the rest
    for (let k = 1; k < group.length; k++) dropped.add(group[k].i);
  }

  const active = segs.filter(s => !dropped.has(s.i));
  if (active.length <= 1) return active.map(s => s.way);

  // Precompute cluster center coordinates
  const clusterMembers = new Map(); // clusterId → [coords]
  for (let i = 0; i < allEps.length; i++) {
    const cid = clusterId(i);
    if (!clusterMembers.has(cid)) clusterMembers.set(cid, []);
    clusterMembers.get(cid).push(allEps[i]);
  }
  const clusterCoords = new Map();
  for (const [cid, members] of clusterMembers) {
    clusterCoords.set(cid, [
      members.reduce((s, c) => s + c[0], 0) / members.length,
      members.reduce((s, c) => s + c[1], 0) / members.length,
    ]);
  }

  // --- Build adjacency: cluster → [seg indices] ---
  const adj = new Map();
  for (const seg of active) {
    if (!adj.has(seg.startCluster)) adj.set(seg.startCluster, []);
    if (!adj.has(seg.endCluster)) adj.set(seg.endCluster, []);
    adj.get(seg.startCluster).push(seg.i);
    adj.get(seg.endCluster).push(seg.i);
  }

  // --- Find connected components ---
  const segMap = new Map(active.map(s => [s.i, s]));
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
        for (const ni of adj.get(cl) || []) {
          if (!seen.has(ni)) stack.push(ni);
        }
      }
    }
    components.push(comp);
  }

  // --- Walk each component ---
  // Try starting from each odd-degree vertex, pick the walk with fewest reversals.
  function doWalk(segIds, startV) {
    const unused = new Set(segIds);
    let cur = startV;
    const result = [];
    while (unused.size > 0) {
      const incident = (adj.get(cur) || []).filter(si => unused.has(si));
      if (incident.length === 0) {
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
        continue;
      }
      const nextSi = incident[0];
      unused.delete(nextSi);
      const seg = segMap.get(nextSi);
      result.push(seg.way);
      cur = seg.startCluster === cur ? seg.endCluster : seg.startCluster;
    }
    return result;
  }

  function countReversals(orderedWays) {
    let revs = 0, lastB = null, prev = null;
    for (const w of orderedWays) {
      const coords = w.geometry.map(p => [p.lon, p.lat]);
      let trace = coords;
      if (prev) {
        if (haversineM(prev, coords[coords.length - 1]) < haversineM(prev, coords[0]))
          trace = [...coords].reverse();
      }
      if (trace.length >= 2) {
        const b = Math.atan2(trace[trace.length - 1][0] - trace[0][0], trace[trace.length - 1][1] - trace[0][1]);
        if (lastB !== null) {
          let df = Math.abs(b - lastB); if (df > Math.PI) df = 2 * Math.PI - df;
          if (df > 2 * Math.PI / 3) revs++;
        }
        lastB = b;
      }
      prev = trace[trace.length - 1];
    }
    return revs;
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
      // On tie, prefer walk where first reversal is later (spur at end)
      let firstRev = result.length;
      if (revs > 0) {
        let lb = null, prev = null;
        for (let k = 0; k < result.length; k++) {
          const coords = result[k].geometry.map(p => [p.lon, p.lat]);
          let trace = coords;
          if (prev && haversineM(prev, coords[coords.length - 1]) < haversineM(prev, coords[0]))
            trace = [...coords].reverse();
          if (trace.length >= 2) {
            const b = Math.atan2(trace[trace.length - 1][0] - trace[0][0], trace[trace.length - 1][1] - trace[0][1]);
            if (lb !== null) { let df = Math.abs(b - lb); if (df > Math.PI) df = 2 * Math.PI - df; if (df > 2 * Math.PI / 3) { firstRev = k; break; } }
            lb = b;
          }
          prev = trace[trace.length - 1];
        }
      }
      if (revs < bestRevs || (revs === bestRevs && firstRev > bestFirstRev)) {
        bestRevs = revs; bestResult = result; bestFirstRev = firstRev;
      }
    }
    return bestResult;
  }

  function clusterCoord(cid) {
    return clusterCoords.get(cid) || [0, 0];
  }

  // Walk each component, stitch by nearest endpoints
  const walked = components.map(comp => {
    const ordered = walkComponent(comp);
    if (ordered.length === 0) return { ways: [], start: [0, 0], end: [0, 0] };
    const first = ordered[0], last = ordered[ordered.length - 1];
    return {
      ways: ordered,
      start: [first.geometry[0].lon, first.geometry[0].lat],
      end: [last.geometry[last.geometry.length - 1].lon, last.geometry[last.geometry.length - 1].lat],
    };
  }).filter(c => c.ways.length > 0);

  // Sort components by size (largest first), stitch by nearest endpoints
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
      ? { ways: [...comp.ways].reverse(), start: comp.end, end: comp.start }
      : comp;
    if (best.place === 'append') chain.push(norm);
    else chain.unshift(norm);
  }

  return chain.flatMap(c => c.ways);
}
