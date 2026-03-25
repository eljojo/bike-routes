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

function buildAxis(segments, bearing) {
  const name = segments[0].nombre;
  const comunas = [...new Set(segments.map((s) => s.comuna).filter(Boolean))].sort();

  // Slug: name + up to 2 comunas
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

    // --- Union-Find: chain segments whose endpoints are ≤ 200 m apart ---
    const n = sorted.length;
    const uf = makeUF(n);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const { distance } = minEndpointDistance(sorted[i], sorted[j]);
        if (distance <= CHAIN_THRESHOLD_M) {
          uf.union(i, j);
        }
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
      if (small.totalInfraM > SMALL_AXIS_M && small.segments.length > 2) continue;

      const smallBearing = axisBearing(small);
      let bestTarget = -1;
      let bestDist = Infinity;

      for (let j = 0; j < axes.length; j++) {
        if (j === i) continue;
        const big = axes[j];
        // Check bearing compatibility
        if (bearingDiff(smallBearing, axisBearing(big)) > MIN_BEARING_COMPAT) continue;

        // Check endpoint proximity
        const smallSegs = small.segments;
        const bigSegs = big.segments;
        const pairs = [
          [smallSegs[0], bigSegs[0]],
          [smallSegs[0], bigSegs[bigSegs.length - 1]],
          [smallSegs[smallSegs.length - 1], bigSegs[0]],
          [smallSegs[smallSegs.length - 1], bigSegs[bigSegs.length - 1]],
        ];
        for (const [a, b] of pairs) {
          const d = minEndpointDistance(a, b).distance;
          if (d < bestDist) {
            bestDist = d;
            bestTarget = j;
          }
        }
      }

      if (bestTarget >= 0 && bestDist <= MERGE_ENDPOINT_M) {
        // Check name diversity — don't create Frankenstein axes
        const target = axes[bestTarget];
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
