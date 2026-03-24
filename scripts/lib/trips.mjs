/**
 * Pass 3 — Trip stitching.
 *
 * Generates candidate routes by connecting axes between anchor pairs,
 * scores them, deduplicates, and assigns semantic tags.
 */

import { haversineM, minEndpointDistance } from './geo.mjs';
import { slugify } from './slugify.mjs';
import { assignTags } from './tags.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_ROUTE_KM = 2;
const MAX_ROUTE_KM = 25;
const MAX_GAP_M = 2000;
const AXIS_TO_ANCHOR_THRESHOLD_M = 800;
const MIN_ANCHOR_SCORE = 5;
const MIN_PAIR_ANCHOR_SCORE = 7;
const MAX_CANDIDATES_PER_PAIR = 3;
const DEDUP_OVERLAP_THRESHOLD = 0.6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Build the route output object from axes and anchors. */
function buildRoute(axisChain, startAnchor, endAnchor) {
  // Compute gaps between consecutive axes
  const gaps = [];
  for (let i = 1; i < axisChain.length; i++) {
    const prev = axisChain[i - 1];
    const curr = axisChain[i];
    // Find closest endpoints between last segment of prev and first segment of curr
    const prevSegs = prev.segments;
    const currSegs = curr.segments;
    const { distance, fromEnd, toEnd } = minEndpointDistance(
      prevSegs[prevSegs.length - 1],
      currSegs[0],
    );
    if (distance > 10) {
      gaps.push({
        afterAxis: prev.slug,
        distanceM: Math.round(distance),
        from: prevSegs[prevSegs.length - 1][fromEnd],
        to: currSegs[0][toEnd],
      });
    }
  }

  const infraDistanceM = axisChain.reduce((s, a) => s + a.totalInfraM, 0);
  const gapDistanceM = gaps.reduce((s, g) => s + g.distanceM, 0);
  const totalDistanceM = infraDistanceM + gapDistanceM;
  const infraPercent = totalDistanceM > 0
    ? Math.round((infraDistanceM / totalDistanceM) * 100)
    : 0;

  // Average condition score across all segments
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

  // Collect all videos
  const videos = axisChain.flatMap((a) =>
    a.segments.filter((s) => s.video).map((s) => s.video),
  );

  const name = `De ${startAnchor.name} a ${endAnchor.name}`;

  const route = {
    name,
    slug: slugify(name),
    startAnchor: { name: startAnchor.name, lat: startAnchor.lat, lng: startAnchor.lng },
    endAnchor: { name: endAnchor.name, lat: endAnchor.lat, lng: endAnchor.lng },
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
        geometry: s.geometry,
      })),
      comunas: a.comunas,
      totalInfraM: a.totalInfraM,
    })),
    gaps,
    totalDistanceM: Math.round(totalDistanceM),
    infraDistanceM: Math.round(infraDistanceM),
    infraPercent,
    avgConditionScore,
    compositeScore: 0, // computed below
    videos,
    waypointPOIs: [],
    suggestedTags: [],
  };

  // --- Score ---
  const infraScore = infraPercent / 10; // 0-10
  const condScore = avgConditionScore;  // 0-10
  const gapPenalty = Math.min(gapDistanceM / 500, 5);
  const anchorScoreVal = (startAnchor.anchorScore + endAnchor.anchorScore) / 4; // 0-5
  const distancePenalty = totalDistanceM > 15000 ? 2 : 0;
  route.compositeScore = Math.round(
    (infraScore + condScore + anchorScoreVal - gapPenalty - distancePenalty) * 10,
  ) / 10;

  // --- Tags ---
  route.suggestedTags = assignTags(route);

  return route;
}

/** Check if total distance is within bounds. */
function distanceInRange(axisChain, gapTotal) {
  const infraM = axisChain.reduce((s, a) => s + a.totalInfraM, 0);
  const totalM = infraM + gapTotal;
  return totalM >= MIN_ROUTE_KM * 1000 && totalM <= MAX_ROUTE_KM * 1000;
}

/** Estimate total gap distance for a chain of axes. */
function estimateGaps(axisChain) {
  let total = 0;
  for (let i = 1; i < axisChain.length; i++) {
    const prevSegs = axisChain[i - 1].segments;
    const currSegs = axisChain[i].segments;
    const { distance } = minEndpointDistance(
      prevSegs[prevSegs.length - 1],
      currSegs[0],
    );
    total += distance;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Stitch axes into trip routes between anchor pairs.
 *
 * @param {Array} axes - output of detectAxes()
 * @param {Array} anchors - output of scoreAnchors()
 * @param {object} [options]
 * @returns {Array} routes sorted by compositeScore desc
 */
export function stitchTrips(axes, anchors, options = {}) {
  const minAnchorScore = options.minAnchorScore ?? MIN_ANCHOR_SCORE;

  // --- Step 1: Map anchors to nearby axes ---
  const anchorAxes = new Map(); // anchor index → Set of axis indices
  const axisAnchors = new Map(); // axis index → Set of anchor indices

  const usableAnchors = anchors.filter((a) => a.anchorScore >= minAnchorScore);
  console.log(`[trips] ${usableAnchors.length} anchors with score >= ${minAnchorScore}`);

  for (let ai = 0; ai < usableAnchors.length; ai++) {
    const anchor = usableAnchors[ai];
    const nearAxes = new Set();
    for (let xi = 0; xi < axes.length; xi++) {
      if (anchorToAxisDist(anchor, axes[xi]) <= AXIS_TO_ANCHOR_THRESHOLD_M) {
        nearAxes.add(xi);
        if (!axisAnchors.has(xi)) axisAnchors.set(xi, new Set());
        axisAnchors.get(xi).add(ai);
      }
    }
    if (nearAxes.size > 0) {
      anchorAxes.set(ai, nearAxes);
    }
  }

  // --- Step 2: Filter to anchors with at least one nearby axis ---
  const validAnchorIndices = [...anchorAxes.keys()];
  console.log(`[trips] ${validAnchorIndices.length} anchors with nearby axes`);

  // For pair generation, use higher threshold to limit combinatorial explosion
  const pairAnchorScore = options.minPairAnchorScore ?? MIN_PAIR_ANCHOR_SCORE;
  const pairAnchorIndices = validAnchorIndices.filter(
    (ai) => usableAnchors[ai].anchorScore >= pairAnchorScore,
  );
  console.log(`[trips] ${pairAnchorIndices.length} anchors with score >= ${pairAnchorScore} for pair generation`);

  // --- Precompute axis centroids for geographic filtering ---
  const axisCentroids = axes.map((axis) => {
    let sumLng = 0, sumLat = 0, count = 0;
    for (const seg of axis.segments) {
      sumLng += seg.centroid[0];
      sumLat += seg.centroid[1];
      count++;
    }
    return [sumLng / count, sumLat / count]; // [lng, lat]
  });

  // --- Precompute axis endpoint connections (within MAX_GAP_M) ---
  // Only compute for axes that are near at least one anchor (relevant axes)
  const relevantAxisIndices = new Set();
  for (const axSet of anchorAxes.values()) {
    for (const xi of axSet) relevantAxisIndices.add(xi);
  }
  // Also include axes that could serve as middle connectors (near relevant axes)
  console.log(`[trips] Precomputing axis connections for ${relevantAxisIndices.size} relevant axes...`);
  const axisConnections = new Map();
  for (const i of relevantAxisIndices) {
    const connections = new Set();
    const segsI = axes[i].segments;
    const endpointsI = [segsI[0], segsI[segsI.length - 1]];
    for (let j = 0; j < axes.length; j++) {
      if (i === j) continue;
      const segsJ = axes[j].segments;
      const endpointsJ = [segsJ[0], segsJ[segsJ.length - 1]];
      let connected = false;
      for (const ei of endpointsI) {
        for (const ej of endpointsJ) {
          if (minEndpointDistance(ei, ej).distance <= MAX_GAP_M) {
            connected = true;
            break;
          }
        }
        if (connected) break;
      }
      if (connected) connections.add(j);
    }
    axisConnections.set(i, connections);
  }
  // For middle axes in 3-axis routes, also compute their connections
  const middleAxes = new Set();
  for (const i of relevantAxisIndices) {
    const conns = axisConnections.get(i);
    if (conns) for (const j of conns) middleAxes.add(j);
  }
  for (const i of middleAxes) {
    if (axisConnections.has(i)) continue;
    const connections = new Set();
    const segsI = axes[i].segments;
    const endpointsI = [segsI[0], segsI[segsI.length - 1]];
    for (const j of relevantAxisIndices) {
      if (i === j) continue;
      const segsJ = axes[j].segments;
      const endpointsJ = [segsJ[0], segsJ[segsJ.length - 1]];
      let connected = false;
      for (const ei of endpointsI) {
        for (const ej of endpointsJ) {
          if (minEndpointDistance(ei, ej).distance <= MAX_GAP_M) {
            connected = true;
            break;
          }
        }
        if (connected) break;
      }
      if (connected) connections.add(j);
    }
    axisConnections.set(i, connections);
  }

  // --- Step 3: Generate candidate routes ---
  const candidates = [];

  console.log('[trips] Generating anchor pair routes...');
  for (let i = 0; i < pairAnchorIndices.length; i++) {
    const aiA = pairAnchorIndices[i];
    const anchorA = usableAnchors[aiA];
    const axesA = anchorAxes.get(aiA);

    for (let j = i + 1; j < pairAnchorIndices.length; j++) {
      const aiB = pairAnchorIndices[j];
      const anchorB = usableAnchors[aiB];
      const axesB = anchorAxes.get(aiB);

      // Quick distance check
      const directDist = haversineM(
        [anchorA.lng, anchorA.lat],
        [anchorB.lng, anchorB.lat],
      );
      if (directDist < MIN_ROUTE_KM * 800 || directDist > MAX_ROUTE_KM * 1200) {
        continue;
      }

      let pairCandidates = 0;

      // --- 1-axis routes: same axis near both anchors ---
      for (const xi of axesA) {
        if (pairCandidates >= MAX_CANDIDATES_PER_PAIR) break;
        if (!axesB.has(xi)) continue;
        const chain = [axes[xi]];
        const gapM = estimateGaps(chain);
        if (distanceInRange(chain, gapM)) {
          candidates.push(buildRoute(chain, anchorA, anchorB));
          pairCandidates++;
        }
      }

      // --- 2-axis routes ---
      if (pairCandidates < MAX_CANDIDATES_PER_PAIR) {
        for (const startXi of axesA) {
          if (pairCandidates >= MAX_CANDIDATES_PER_PAIR) break;
          const startConns = axisConnections.get(startXi);
          if (!startConns) continue;
          for (const endXi of axesB) {
            if (pairCandidates >= MAX_CANDIDATES_PER_PAIR) break;
            if (endXi === startXi) continue;
            if (!startConns.has(endXi)) continue;
            const chain = [axes[startXi], axes[endXi]];
            const gapM = estimateGaps(chain);
            if (distanceInRange(chain, gapM)) {
              candidates.push(buildRoute(chain, anchorA, anchorB));
              pairCandidates++;
            }
          }
        }
      }

      // --- 3-axis routes ---
      if (pairCandidates < MAX_CANDIDATES_PER_PAIR) {
        // Geographic bounding box for middle axis filtering
        const minLat = Math.min(anchorA.lat, anchorB.lat);
        const maxLat = Math.max(anchorA.lat, anchorB.lat);
        const minLng = Math.min(anchorA.lng, anchorB.lng);
        const maxLng = Math.max(anchorA.lng, anchorB.lng);
        const latMargin = (maxLat - minLat) * 0.3 + 0.01;
        const lngMargin = (maxLng - minLng) * 0.3 + 0.01;

        for (const startXi of axesA) {
          if (pairCandidates >= MAX_CANDIDATES_PER_PAIR) break;
          const startConns = axisConnections.get(startXi);
          if (!startConns) continue;

          for (const midXi of startConns) {
            if (pairCandidates >= MAX_CANDIDATES_PER_PAIR) break;
            if (midXi === startXi) continue;

            // Geographic filter: middle axis centroid between anchors
            const [midLng, midLat] = axisCentroids[midXi];
            if (
              midLat < minLat - latMargin || midLat > maxLat + latMargin ||
              midLng < minLng - lngMargin || midLng > maxLng + lngMargin
            ) {
              continue;
            }

            const midConns = axisConnections.get(midXi);
            if (!midConns) continue;

            for (const endXi of axesB) {
              if (pairCandidates >= MAX_CANDIDATES_PER_PAIR) break;
              if (endXi === startXi || endXi === midXi) continue;
              if (!midConns.has(endXi)) continue;
              const chain = [axes[startXi], axes[midXi], axes[endXi]];
              const gapM = estimateGaps(chain);
              if (distanceInRange(chain, gapM)) {
                candidates.push(buildRoute(chain, anchorA, anchorB));
                pairCandidates++;
              }
            }
          }
        }
      }
    }
  }

  console.log(`[trips] ${candidates.length} candidates from anchor pairs`);

  // --- Step 4: Single-axis routes for long axes with nearby anchors ---
  for (let xi = 0; xi < axes.length; xi++) {
    const axis = axes[xi];
    if (axis.totalInfraM < MIN_ROUTE_KM * 1000) continue;
    const nearAnchors = axisAnchors.get(xi);
    if (!nearAnchors || nearAnchors.size === 0) continue;

    // Pick the two best anchors for this axis
    const sortedAnchors = [...nearAnchors]
      .map((ai) => usableAnchors[ai])
      .sort((a, b) => b.anchorScore - a.anchorScore);

    if (sortedAnchors.length >= 2) {
      const chain = [axis];
      const gapM = estimateGaps(chain);
      if (distanceInRange(chain, gapM)) {
        candidates.push(buildRoute(chain, sortedAnchors[0], sortedAnchors[1]));
      }
    } else if (sortedAnchors.length === 1) {
      // Use same anchor for start and end (out-and-back implied)
      const chain = [axis];
      const gapM = estimateGaps(chain);
      if (distanceInRange(chain, gapM)) {
        candidates.push(buildRoute(chain, sortedAnchors[0], sortedAnchors[0]));
      }
    }
  }

  console.log(`[trips] ${candidates.length} total candidates (including single-axis)`);

  // --- Step 5 & 6: Deduplicate ---
  candidates.sort((a, b) => b.compositeScore - a.compositeScore);

  const kept = [];
  for (const route of candidates) {
    const routeSlugs = new Set(route.axes.map((a) => a.slug));
    let dominated = false;
    for (const existing of kept) {
      const existingSlugs = new Set(existing.axes.map((a) => a.slug));
      // Count overlap
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
