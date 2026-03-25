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

import { haversineM, minEndpointDistance } from './geo.mjs';
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
  // No geometry dedup needed — OSM is the sole geometry source, so each
  // way is unique. The old dedup was for catastro+OSM overlap which no
  // longer exists in the pipeline.
  const segments = [...rawSegments];

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

    // Track which endpoint we exit from — the "frontier" of the chain.
    // Start from whichever endpoint of the first segment is most extreme.
    let frontier = bearing === 'north-south'
      ? (segments[startIdx].start[1] < segments[startIdx].end[1] ? segments[startIdx].start : segments[startIdx].end)
      : (segments[startIdx].start[0] < segments[startIdx].end[0] ? segments[startIdx].start : segments[startIdx].end);
    // We enter from the extreme end, so we exit from the OTHER end
    frontier = frontier === segments[startIdx].start ? segments[startIdx].end : segments[startIdx].start;

    while (ordered.length < segments.length) {
      let bestIdx = -1;
      let bestDist = Infinity;
      let bestExit = null;

      for (let k = 0; k < segments.length; k++) {
        if (used.has(k)) continue;
        // Check distance from frontier to both endpoints of candidate
        const dStart = haversineM(frontier, segments[k].start);
        const dEnd = haversineM(frontier, segments[k].end);
        const d = Math.min(dStart, dEnd);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = k;
          // We enter from the closer end, so we exit from the other
          bestExit = dStart <= dEnd ? segments[k].end : segments[k].start;
        }
      }

      if (bestIdx === -1) break;
      used.add(bestIdx);
      ordered.push(segments[bestIdx]);
      frontier = bestExit;
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
  const MAX_NAMES_PER_AXIS = 10;  // one road can have many names across comunas (e.g. Alameda)

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

        // Don't merge a named axis into a differently-named axis.
        // "MAPOCHO 42K" should not be absorbed into "COSTANERA SUR"
        // just because they run parallel along the same river.
        const smallHasName = small.segments.some((s) => s.normalizedName);
        const targetHasName = target.segments.some((s) => s.normalizedName);
        if (smallHasName && targetHasName) {
          const smallMainName = small.segments.find((s) => s.normalizedName)?.normalizedName;
          const targetMainName = target.segments.find((s) => s.normalizedName)?.normalizedName;
          if (smallMainName && targetMainName && smallMainName !== targetMainName) {
              continue;
          }
        }

        // Don't merge unnamed road segments into named bike infrastructure.
        const smallIsUnnamedRoad = !smallHasName &&
          small.segments.some((s) => s.emplazamiento === 'calzada');
        if (targetHasName && smallIsUnnamedRoad) continue;

        // Collinearity check: the small axis should follow the same line as
        // the target, not cut diagonally across it. Compare the bearing of
        // the gap (target end → small start) with the target's bearing.
        // A diagonal shortcut has a gap bearing ~45°+ off the axis bearing.
        const gapBearingA = Math.atan2(
          smallFirst.centroid[0] - bigLast.centroid[0],
          smallFirst.centroid[1] - bigLast.centroid[1],
        ) * 180 / Math.PI;
        const gapBearingB = Math.atan2(
          bigFirst.centroid[0] - smallLast.centroid[0],
          bigFirst.centroid[1] - smallLast.centroid[1],
        ) * 180 / Math.PI;
        const targetBearing = axisBearing(target);
        const gapAlignA = bearingDiff(((gapBearingA % 360) + 360) % 360, targetBearing);
        const gapAlignB = bearingDiff(((gapBearingB % 360) + 360) % 360, targetBearing);
        const gapAlign = Math.min(gapAlignA, gapAlignB);
        // Allow some tolerance (45°) but reject clearly diagonal connections
        if (gapAlign > 45 && bestDist > 100) continue;

        // Merge small into target: append segments and rebuild
        const hasM42 = small.segments.some(s => s.normalizedName === 'MAPOCHO 42K') || target.segments.some(s => s.normalizedName === 'MAPOCHO 42K');
        if (hasM42) console.log(`[axes] MERGE: "${small.name}" (${Math.round(small.totalInfraM)}m) INTO "${target.name}" (${Math.round(target.totalInfraM)}m)`);
        const allSegs = [...target.segments, ...small.segments];
        // Re-sort by position along dominant orientation
        const dom = target.bearing === 'north-south' ? 'ns' : 'ew';
        allSegs.sort((a, b) =>
          dom === 'ns'
            ? a.centroid[1] - b.centroid[1]
            : a.centroid[0] - b.centroid[0],
        );
        // Append small's segments to target without full rebuild.
        for (const seg of small.segments) {
          target.segments.push(seg);
          target.totalInfraM += seg.lengthM || 0;
        }
        target.comunas = [...new Set(target.segments.map(s => s.comuna).filter(Boolean))].sort();
        axes[bestTarget] = target;
        axes.splice(i, 1);
        merged = true;
        break; // restart from end after each merge
      }
    }
  }

  // --- Corridor continuation pass ---
  // Merge axes of any size when they clearly continue the same corridor:
  // sequential endpoints close together, compatible bearing, and the axes
  // don't run side-by-side. This catches cases like Concha y Toro → Vicuña
  // Mackenna where the street changes name at a comuna boundary.
  const CORRIDOR_ENDPOINT_M = 400;
  const CORRIDOR_BEARING_COMPAT = 25;

  merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < axes.length; i++) {
      const axisA = axes[i];
      const bearingA = axisBearing(axisA);
      const aFirst = axisA.segments[0];
      const aLast = axisA.segments[axisA.segments.length - 1];

      for (let j = i + 1; j < axes.length; j++) {
        const axisB = axes[j];
        if (bearingDiff(bearingA, axisBearing(axisB)) > CORRIDOR_BEARING_COMPAT) continue;

        const bFirst = axisB.segments[0];
        const bLast = axisB.segments[axisB.segments.length - 1];

        // Only sequential: A's end → B's start or B's end → A's start
        const abDist = haversineM(aLast.end, bFirst.start);
        const baDist = haversineM(bLast.end, aFirst.start);
        const seqDist = Math.min(abDist, baDist);
        if (seqDist > CORRIDOR_ENDPOINT_M) continue;

        // Reject parallel (both ends close)
        const ssD = haversineM(aFirst.centroid, bFirst.centroid);
        const eeD = haversineM(aLast.centroid, bLast.centroid);
        const seD = haversineM(aFirst.centroid, bLast.centroid);
        const esD = haversineM(aLast.centroid, bFirst.centroid);
        const bothClose = (ssD < 500 && eeD < 500) || (seD < 500 && esD < 500);
        if (bothClose && axisA.totalInfraM > 500 && axisB.totalInfraM > 500) continue;

        // Direction suffix check
        const DIRECTION_PAIRS = [['PONIENTE', 'ORIENTE'], ['NORTE', 'SUR']];
        const nameA = (axisA.name || '').toUpperCase();
        const nameB = (axisB.name || '').toUpperCase();
        let dirConflict = false;
        for (const [da, db] of DIRECTION_PAIRS) {
          if ((nameA.includes(da) && nameB.includes(db)) ||
              (nameA.includes(db) && nameB.includes(da))) {
            dirConflict = true;
            break;
          }
        }
        if (dirConflict) continue;

        // Name diversity cap
        const namesA = new Set(axisA.segments.map((s) => s.normalizedName).filter(Boolean));
        const namesB = new Set(axisB.segments.map((s) => s.normalizedName).filter(Boolean));
        const combined = new Set([...namesA, ...namesB]);
        if (combined.size > MAX_NAMES_PER_AXIS) continue;

        // Don't merge differently-named axes — "MAPOCHO 42K" should not
        // be absorbed into "COSTANERA SUR" just because they run parallel.
        const aHasName = axisA.segments.some((s) => s.normalizedName);
        const bHasName = axisB.segments.some((s) => s.normalizedName);
        if (aHasName && bHasName) {
          const aMainName = axisA.segments.find((s) => s.normalizedName)?.normalizedName;
          const bMainName = axisB.segments.find((s) => s.normalizedName)?.normalizedName;
          if (aMainName && bMainName && aMainName !== bMainName) continue;
        }

        const aIsUnnamedRoad = !aHasName && axisA.segments.some((s) => s.emplazamiento === 'calzada');
        const bIsUnnamedRoad = !bHasName && axisB.segments.some((s) => s.emplazamiento === 'calzada');
        if ((aHasName && bIsUnnamedRoad) || (bHasName && aIsUnnamedRoad)) continue;

        // Merge: combine segments and rebuild
        const allSegs = [...axisA.segments, ...axisB.segments];
        const dom = axisA.bearing === 'north-south' ? 'ns' : 'ew';
        allSegs.sort((a, b) =>
          dom === 'ns'
            ? a.centroid[1] - b.centroid[1]
            : a.centroid[0] - b.centroid[0],
        );
        axes[i] = buildAxis(allSegs, axisA.bearing);
        axes.splice(j, 1);
        merged = true;
        break;
      }
      if (merged) break;
    }
  }

  // --- Sort axes by totalInfraM descending ---
  axes.sort((a, b) => b.totalInfraM - a.totalInfraM);

  return axes;
}
