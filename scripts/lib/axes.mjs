/**
 * Pass 1 — Axis detection.
 *
 * Groups segments into street-axis corridors:
 *   1. Group by normalizedName (unnamed segments → own axis each)
 *   2. Determine dominant orientation (ns/ew) by majority vote
 *   3. Sort by latitude centroid (ns) or longitude centroid (ew)
 *   4. Chain geographically continuous segments via union-find (endpoints ≤ 200 m)
 *   5. Each chain = one axis
 */

import { haversineM, minEndpointDistance, allCoords } from './geo.mjs';
import { slugify } from './slugify.mjs';

const CHAIN_THRESHOLD_M = 200;
const GAP_REPORT_MIN_M = 10;

// ---------------------------------------------------------------------------
// Union-Find
// ---------------------------------------------------------------------------

function makeUF(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array(n).fill(0);
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) parent[ra] = rb;
    else if (rank[ra] > rank[rb]) parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]++; }
  }
  return { find, union };
}

// ---------------------------------------------------------------------------
// Condition ordering (best → worst)
// ---------------------------------------------------------------------------

const CONDITION_ORDER = ['buena', 'regular', 'mala', 'muy mala'];

function bestOfTwo(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  const ia = CONDITION_ORDER.indexOf(a.toLowerCase());
  const ib = CONDITION_ORDER.indexOf(b.toLowerCase());
  if (ia === -1) return b;
  if (ib === -1) return a;
  return ia <= ib ? a : b;
}

function worstOfTwo(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  const ia = CONDITION_ORDER.indexOf(a.toLowerCase());
  const ib = CONDITION_ORDER.indexOf(b.toLowerCase());
  if (ia === -1) return a;
  if (ib === -1) return b;
  return ia >= ib ? a : b;
}

// ---------------------------------------------------------------------------
// Build one axis object from an ordered array of segments
// ---------------------------------------------------------------------------

function buildAxis(rawSegments, bearing) {
  // Deduplicate overlapping segments by tracing actual path geometry.
  // Sample points along each segment and check if another segment covers
  // the same ground. If >40% of a shorter segment's sampled points are
  // within 80m of a longer segment's path, it's a duplicate — drop it.
  const segments = [];
  const used = new Set();
  const byLength = [...rawSegments].sort((a, b) => b.lengthM - a.lengthM);

  // Pre-compute sampled points for each segment (every ~100m)
  const sampledPoints = byLength.map((seg) => {
    const coords = allCoords(seg.geometry);
    if (coords.length <= 3) return coords;
    const step = Math.max(1, Math.floor(coords.length / Math.ceil(seg.lengthM / 100)));
    const pts = [];
    for (let k = 0; k < coords.length; k += step) pts.push(coords[k]);
    if (pts[pts.length - 1] !== coords[coords.length - 1]) pts.push(coords[coords.length - 1]);
    return pts;
  });

  for (let i = 0; i < byLength.length; i++) {
    if (used.has(i)) continue;
    segments.push(byLength[i]);

    const aPts = sampledPoints[i];
    for (let j = i + 1; j < byLength.length; j++) {
      if (used.has(j)) continue;
      // Quick bounding box pre-filter
      if (haversineM(byLength[i].centroid, byLength[j].centroid) > byLength[i].lengthM + 500) continue;

      const bPts = sampledPoints[j];
      // Check how many of b's points are near a's path
      let nearCount = 0;
      for (const bp of bPts) {
        for (const ap of aPts) {
          if (haversineM(bp, ap) < 80) { nearCount++; break; }
        }
      }
      if (bPts.length > 0 && nearCount / bPts.length > 0.4) {
        used.add(j); // b is covered by a — drop it
      }
    }
  }

  // Greedy nearest-endpoint chaining: start from the segment with the
  // most extreme position, always pick the closest unused segment.
  // This produces ride-order instead of centroid-order, avoiding
  // mini-loops and backtracking.
  if (segments.length > 1) {
    // Start from the segment with the lowest centroid (south-most or west-most)
    const startIdx = segments.reduce((best, seg, i) => {
      const val = bearing === 'north-south' ? seg.centroid[1] : seg.centroid[0];
      const bestVal = bearing === 'north-south' ? segments[best].centroid[1] : segments[best].centroid[0];
      return val < bestVal ? i : best;
    }, 0);

    const ordered = [segments[startIdx]];
    const used = new Set([startIdx]);

    while (ordered.length < segments.length) {
      const last = ordered[ordered.length - 1];
      const lastEnd = last.end;
      let bestIdx = -1;
      let bestDist = Infinity;

      for (let k = 0; k < segments.length; k++) {
        if (used.has(k)) continue;
        // Check distance from last segment's end to this segment's start and end
        const dStart = haversineM(lastEnd, segments[k].start);
        const dEnd = haversineM(lastEnd, segments[k].end);
        const d = Math.min(dStart, dEnd);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = k;
        }
      }

      if (bestIdx === -1) break;
      used.add(bestIdx);
      ordered.push(segments[bestIdx]);
    }

    segments.length = 0;
    segments.push(...ordered);
  }

  const name = segments[0].nombre;
  const comunas = [...new Set(segments.map((s) => s.comuna).filter(Boolean))].sort();

  const slugParts = [name, ...(comunas.length <= 2 ? comunas : [comunas[0]])];
  const slug = slugify(slugParts.join(' '));

  let totalInfraM = 0;
  let totalGapM = 0;
  const gapsWithinAxis = [];
  let scoreSum = 0;
  let scoreCount = 0;
  let bestCondition = null;
  let worstCondition = null;
  const videos = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    totalInfraM += seg.lengthM;

    const sc = seg.score;
    if (sc != null && !Number.isNaN(Number(sc))) {
      scoreSum += Number(sc);
      scoreCount++;
    }

    bestCondition = bestOfTwo(bestCondition, seg.clasificacion);
    worstCondition = worstOfTwo(worstCondition, seg.clasificacion);

    if (seg.video) videos.push(seg.video);

    if (i > 0) {
      const { distance } = minEndpointDistance(segments[i - 1], seg);
      if (distance > GAP_REPORT_MIN_M) {
        gapsWithinAxis.push({
          afterSegmentIndex: i - 1,
          distanceM: distance,
          from: segments[i - 1].end,
          to: seg.start,
        });
        totalGapM += distance;
      }
    }
  }

  return {
    name,
    slug,
    segments,
    comunas,
    totalInfraM,
    totalGapM,
    gapsWithinAxis,
    bearing,
    avgConditionScore: scoreCount > 0 ? scoreSum / scoreCount : null,
    bestCondition,
    worstCondition,
    videos,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function detectAxes(segments) {
  const axes = [];

  // --- Separate unnamed segments (each becomes its own axis) ---
  const named = [];
  for (const seg of segments) {
    if (!seg.normalizedName) {
      axes.push(buildAxis([seg], seg.orientation === 'ns' ? 'north-south' : 'east-west'));
    } else {
      named.push(seg);
    }
  }

  // --- Group named segments by normalizedName ---
  const groups = new Map();
  for (const seg of named) {
    const key = seg.normalizedName;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(seg);
  }

  for (const [, group] of groups) {
    // --- Dominant orientation by majority vote ---
    let nsCount = 0, ewCount = 0;
    for (const seg of group) {
      if (seg.orientation === 'ns') nsCount++;
      else ewCount++;
    }
    const dominantOrientation = nsCount >= ewCount ? 'ns' : 'ew';
    const bearingLabel = dominantOrientation === 'ns' ? 'north-south' : 'east-west';

    // --- Sort by centroid (lat for ns, lng for ew) ---
    const sorted = [...group].sort((a, b) => {
      if (dominantOrientation === 'ns') {
        return a.centroid[1] - b.centroid[1]; // ascending lat (south → north)
      } else {
        return a.centroid[0] - b.centroid[0]; // ascending lng (west → east)
      }
    });

    // --- Union-Find: chain segments that connect sequentially (≤ 200m) ---
    // Only chain end→start or start→end connections (sequential).
    // Reject: start→start (overlapping/forking) and end→end (converging).
    // Also reject parallel segments (both ends close simultaneously).
    const n = sorted.length;
    const uf = makeUF(n);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const esD = haversineM(sorted[i].end, sorted[j].start);    // i flows into j
        const seD = haversineM(sorted[i].start, sorted[j].end);    // j flows into i
        const ssD = haversineM(sorted[i].start, sorted[j].start);
        const eeD = haversineM(sorted[i].end, sorted[j].end);

        // Sequential: one segment's end connects to the other's start
        const sequential = esD <= CHAIN_THRESHOLD_M || seD <= CHAIN_THRESHOLD_M;
        if (!sequential) continue;

        // Reject parallel: both start-start and end-end close (side-by-side)
        const bothEndsClose = (ssD < CHAIN_THRESHOLD_M && eeD < CHAIN_THRESHOLD_M) ||
                              (seD < CHAIN_THRESHOLD_M && esD < CHAIN_THRESHOLD_M);
        if (bothEndsClose && sorted[i].lengthM > 200 && sorted[j].lengthM > 200) continue;

        // Reject overlapping: start-start close means they fork from same point
        // (like two segments of Andres Bello that start at Baquedano)
        if (ssD < CHAIN_THRESHOLD_M && esD > CHAIN_THRESHOLD_M && seD > CHAIN_THRESHOLD_M) continue;
        // end-end close means they converge to same point
        if (eeD < CHAIN_THRESHOLD_M && esD > CHAIN_THRESHOLD_M && seD > CHAIN_THRESHOLD_M) continue;

        uf.union(i, j);
      }
    }

    // --- Collect chains, preserving sort order within each chain ---
    const chainMap = new Map();
    for (let i = 0; i < n; i++) {
      const root = uf.find(i);
      if (!chainMap.has(root)) chainMap.set(root, []);
      chainMap.get(root).push(sorted[i]);
    }

    for (const chainSegs of chainMap.values()) {
      // chainSegs is already in sorted order because we iterated sorted[]
      axes.push(buildAxis(chainSegs, bearingLabel));
    }
  }

  // --- Geometric continuity pass ---
  // Merge small axes (unnamed or short) into nearby larger axes when their
  // endpoints connect, forming continuous corridors regardless of naming.
  // This catches cases like Ottawa's Canal where OSM segment names vary.
  axes.sort((a, b) => b.totalInfraM - a.totalInfraM);

  const MERGE_ENDPOINT_M = 300;   // max gap between axes to consider merging
  const SMALL_AXIS_M = 1000;      // axes shorter than this are merge candidates
  const MIN_BEARING_COMPAT = 30;  // max bearing difference to merge (degrees)
  const MAX_NAMES_PER_AXIS = 4;   // don't merge if result would have too many street names

  function bearingDiff(a, b) {
    const diff = Math.abs(a - b) % 360;
    return Math.min(diff, 360 - diff);
  }

  function axisBearing(axis) {
    const first = axis.segments[0];
    const last = axis.segments[axis.segments.length - 1];
    const dx = last.centroid[0] - first.centroid[0];
    const dy = last.centroid[1] - first.centroid[1];
    return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = axes.length - 1; i >= 0; i--) {
      const small = axes[i];
      if (small.totalInfraM > SMALL_AXIS_M) continue;

      const smallBearing = axisBearing(small);
      let bestTarget = -1;
      let bestDist = Infinity;

      for (let j = 0; j < axes.length; j++) {
        if (j === i) continue;
        const big = axes[j];
        // Check bearing compatibility
        if (bearingDiff(smallBearing, axisBearing(big)) > MIN_BEARING_COMPAT) continue;

        // Check sequential endpoint proximity (end→start or start→end only)
        // Reject start→start (forking) and end→end (converging)
        const smallSegs = small.segments;
        const bigSegs = big.segments;
        const smallStart = smallSegs[0];
        const smallEnd = smallSegs[smallSegs.length - 1];
        const bigStart = bigSegs[0];
        const bigEnd = bigSegs[bigSegs.length - 1];
        // small flows into big start, or big end flows into small
        const seBs = minEndpointDistance(smallEnd, bigStart).distance;
        const beSs = minEndpointDistance(bigEnd, smallStart).distance;
        const seqDist = Math.min(seBs, beSs);
        if (seqDist < bestDist) {
          bestDist = seqDist;
          bestTarget = j;
        }
      }

      if (bestTarget >= 0 && bestDist <= MERGE_ENDPOINT_M) {
        const target = axes[bestTarget];

        // Direction suffix check: never merge poniente↔oriente or norte↔sur
        // These are opposite sides of the same road, not continuous paths.
        const DIRECTION_PAIRS = [['PONIENTE', 'ORIENTE'], ['NORTE', 'SUR']];
        const smallName = (small.name || '').toUpperCase();
        const targetName = (target.name || '').toUpperCase();
        let directionConflict = false;
        for (const [a, b] of DIRECTION_PAIRS) {
          if ((smallName.includes(a) && targetName.includes(b)) ||
              (smallName.includes(b) && targetName.includes(a))) {
            directionConflict = true;
            break;
          }
        }
        if (directionConflict) continue;

        // Parallel check: if start-start AND end-end of the two axes are
        // both close, they run side-by-side (e.g. highway service roads).
        const smallFirst = small.segments[0];
        const smallLast = small.segments[small.segments.length - 1];
        const bigFirst = target.segments[0];
        const bigLast = target.segments[target.segments.length - 1];
        const ssD = haversineM(smallFirst.centroid, bigFirst.centroid);
        const eeD = haversineM(smallLast.centroid, bigLast.centroid);
        const seD = haversineM(smallFirst.centroid, bigLast.centroid);
        const esD = haversineM(smallLast.centroid, bigFirst.centroid);
        const bothClose = (ssD < 500 && eeD < 500) || (seD < 500 && esD < 500);
        if (bothClose && small.totalInfraM > 500 && target.totalInfraM > 500) continue;

        // Check name diversity — don't create Frankenstein axes
        const existingNames = new Set(target.segments.map((s) => s.normalizedName).filter(Boolean));
        const smallNames = new Set(small.segments.map((s) => s.normalizedName).filter(Boolean));
        const combinedNames = new Set([...existingNames, ...smallNames]);
        if (combinedNames.size > MAX_NAMES_PER_AXIS) continue;

        // Merge small into target: append segments and rebuild
        const allSegs = [...target.segments, ...small.segments];
        // Re-sort by position along dominant orientation
        const dom = target.bearing === 'north-south' ? 'ns' : 'ew';
        allSegs.sort((a, b) =>
          dom === 'ns'
            ? a.centroid[1] - b.centroid[1]
            : a.centroid[0] - b.centroid[0],
        );
        axes[bestTarget] = buildAxis(allSegs, target.bearing);
        axes.splice(i, 1);
        merged = true;
        break; // restart from end after each merge
      }
    }
  }

  // --- Sort axes by totalInfraM descending ---
  axes.sort((a, b) => b.totalInfraM - a.totalInfraM);

  return axes;
}
