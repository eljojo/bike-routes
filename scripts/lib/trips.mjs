/**
 * Pass 3 — Trip stitching.
 *
 * Generates candidate routes by exploring axis chains via graph search,
 * then assigning the best anchors to each chain's endpoints.
 *
 * v2: axis-chain-first search (not anchor-pair-first),
 *     tiered gap penalty, route archetypes (loop, out-and-back, spine).
 */

import { haversineM, minEndpointDistance } from './geo.mjs';
import { slugify } from './slugify.mjs';
import { assignTags } from './tags.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_ROUTE_KM = 2;
const MAX_ROUTE_KM = 80;
const MAX_GAP_M = 3000;
const AXIS_TO_ANCHOR_THRESHOLD_M = 3000;
const MIN_ANCHOR_SCORE = 5;
const MAX_CHAIN_AXES = 8;
const MAX_STATES_PER_START = 5000;
const DEDUP_OVERLAP_THRESHOLD = 0.6;
// Point-to-point: total distance / crow-flies. A straight line = 1.0.
// Urban cycling typically 1.5–3.0. Above 3.5 means zigzag garbage.
const MAX_DETOUR_RATIO = 3.5;
// Loops get a more lenient ratio (measured as total / diameter of bounding box)
const MAX_LOOP_DETOUR_RATIO = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Centroid of an axis (average of segment centroids). */
function axisCentroid(axis) {
  let sumLng = 0, sumLat = 0;
  for (const seg of axis.segments) {
    sumLng += seg.centroid[0];
    sumLat += seg.centroid[1];
  }
  const n = axis.segments.length;
  return [sumLng / n, sumLat / n];
}

/**
 * Direction vector from first to last segment centroid.
 * Returns [dx, dy] in degrees (not normalized — length indicates axis extent).
 */
function axisDirection(axis) {
  const first = axis.segments[0].centroid;
  const last = axis.segments[axis.segments.length - 1].centroid;
  return [last[0] - first[0], last[1] - first[1]];
}

/** Dot product of 2D vectors. */
function dot(a, b) { return a[0] * b[0] + a[1] * b[1]; }

/**
 * How well does axis B continue the direction of travel from axis A?
 * Returns a value from -1 (reverses) to +1 (continues perfectly).
 * Uses the vector from A's centroid to B's centroid vs A's direction.
 */
function directionScore(axisA, axisB) {
  const dirA = axisDirection(axisA);
  const centA = axisCentroid(axisA);
  const centB = axisCentroid(axisB);
  const toB = [centB[0] - centA[0], centB[1] - centA[1]];
  const magA = Math.sqrt(dot(dirA, dirA));
  const magB = Math.sqrt(dot(toB, toB));
  if (magA < 1e-10 || magB < 1e-10) return 0;
  return dot(dirA, toB) / (magA * magB);
}

/**
 * Check if gaps go roughly along the route direction, not sideways.
 * A gap that goes perpendicular to the overall route is a red flag —
 * it means the route jumps to a parallel corridor.
 *
 * Returns true if all gaps are directionally coherent.
 */
function gapsAreCoherent(axisChain) {
  if (axisChain.length < 2) return true;

  // Overall route direction: first axis start → last axis end
  const firstSegs = axisChain[0].segments;
  const lastSegs = axisChain[axisChain.length - 1].segments;
  const routeDir = [
    lastSegs[lastSegs.length - 1].centroid[0] - firstSegs[0].centroid[0],
    lastSegs[lastSegs.length - 1].centroid[1] - firstSegs[0].centroid[1],
  ];
  const routeMag = Math.sqrt(dot(routeDir, routeDir));
  if (routeMag < 1e-10) return true; // essentially same point (loop)

  for (let i = 1; i < axisChain.length; i++) {
    const prevSegs = axisChain[i - 1].segments;
    const currSegs = axisChain[i].segments;
    const prevEnd = prevSegs[prevSegs.length - 1].centroid;
    const currStart = currSegs[0].centroid;
    const gapDir = [currStart[0] - prevEnd[0], currStart[1] - prevEnd[1]];
    const gapMag = Math.sqrt(dot(gapDir, gapDir));

    // Only check gaps that are significant (>300m)
    const gapDist = haversineM(prevEnd, currStart);
    if (gapDist < 300) continue;

    if (gapMag < 1e-10) continue;
    const cosAngle = dot(routeDir, gapDir) / (routeMag * gapMag);
    // cos(70°) ≈ 0.34 — reject gaps more than 70° off the route direction
    if (cosAngle < -0.17) return false; // gap goes backwards
    // Also check if gap is purely sideways (|cos| < 0.34 means >70° off)
    if (Math.abs(cosAngle) < 0.34 && gapDist > 500) return false;
  }
  return true;
}

/**
 * Detour ratio: total path distance / crow-flies distance between endpoints.
 * Lower is more coherent. A straight line = 1.0.
 */
function detourRatio(axisChain, totalDistanceM) {
  if (axisChain.length === 1) return 1;
  const firstSegs = axisChain[0].segments;
  const lastSegs = axisChain[axisChain.length - 1].segments;
  const start = firstSegs[0].start;
  const end = lastSegs[lastSegs.length - 1].end;
  const crowFlies = haversineM(start, end);
  if (crowFlies < 100) return totalDistanceM / 1000; // essentially a loop
  return totalDistanceM / crowFlies;
}

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

/** Compute gaps between consecutive axes in a chain. */
function computeGaps(axisChain) {
  const gaps = [];
  for (let i = 1; i < axisChain.length; i++) {
    const prev = axisChain[i - 1];
    const curr = axisChain[i];
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
  return gaps;
}

/** Tiered gap penalty: crossing a street != riding 2km on a road. */
function computeGapPenalty(gaps) {
  let penalty = 0;
  for (const gap of gaps) {
    const d = gap.distanceM;
    if (d < 200) {
      penalty += d / 2000;
    } else if (d < 1000) {
      penalty += 0.1 + (d - 200) / 800;
    } else {
      penalty += 1.1 + (d - 1000) / 500;
    }
  }
  return Math.min(penalty, 8);
}

/** Detect route archetype: loop or one-way. */
function detectArchetype(axisChain, startAnchor, endAnchor) {
  const sameAnchor =
    startAnchor.name === endAnchor.name ||
    haversineM([startAnchor.lng, startAnchor.lat], [endAnchor.lng, endAnchor.lat]) < 500;

  if (sameAnchor && axisChain.length >= 2) return 'loop';
  return 'one-way';
}

/**
 * Loop shape quality: how round/oval is this loop?
 *
 * Measures two things:
 * - Aspect ratio: bounding box width/height (1.0 = square, >3 = narrow slit)
 * - Perimeter efficiency: route distance / (2 * (width + height))
 *   (0.8-1.0 = traces the perimeter cleanly, <0.5 = zigzag or narrow)
 *
 * The Big Loop Around Ottawa scores: aspect 1.2, perimEff 0.89.
 * A narrow out-and-back-disguised-as-loop scores: aspect >3, perimEff <0.5.
 *
 * Returns { aspect, perimEff, isOval }
 */
function loopShape(axisChain, totalDistanceM) {
  const coords = [];
  for (const ax of axisChain) {
    for (const seg of ax.segments) {
      const geo = seg.geometry;
      const c = geo.type === 'MultiLineString' ? geo.coordinates.flat() : geo.coordinates;
      coords.push(...c);
    }
  }
  if (coords.length < 4) return { aspect: 99, perimEff: 0, isOval: false };

  const lats = coords.map((c) => c[1]);
  const lngs = coords.map((c) => c[0]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const width = haversineM([minLng, (minLat + maxLat) / 2], [maxLng, (minLat + maxLat) / 2]);
  const height = haversineM([(minLng + maxLng) / 2, minLat], [(minLng + maxLng) / 2, maxLat]);

  if (width < 100 || height < 100) return { aspect: 99, perimEff: 0, isOval: false };

  const aspect = Math.max(width, height) / Math.min(width, height);
  const perimEff = totalDistanceM / (2 * (width + height));
  // An oval loop: reasonable aspect ratio and traces the perimeter
  const isOval = aspect < 2.5 && perimEff > 0.55;

  return { aspect, perimEff, isOval };
}

/** Title-case a string (handles ñ, lowercases first). */
function titleCase(str) {
  return str
    .toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Generate a name based on route archetype. */
function generateName(archetype, axisChain, startAnchor, endAnchor) {
  const longestAxis = axisChain.reduce((best, a) =>
    a.totalInfraM > best.totalInfraM ? a : best, axisChain[0]);

  const axisName = longestAxis.name && !longestAxis.name.startsWith('unnamed')
    ? titleCase(longestAxis.name)
    : null;

  if (archetype === 'loop') {
    return axisName ? `Circuito ${axisName}` : `Circuito ${startAnchor.name}`;
  }
  // One-way: "De X a Y"
  return `De ${startAnchor.name} a ${endAnchor.name}`;
}

/** Build the route output object from axes and anchors. */
/** Max gap in the actual built route (not connection graph). */
const MAX_BUILT_GAP_M = 3000;

/**
 * Build route or return null if inviable.
 */
function buildRoute(axisChain, startAnchor, endAnchor) {
  const gaps = computeGaps(axisChain);

  // Reject routes with any single gap too large in the actual trace.
  // The connection graph links axes within 3km of ANY endpoint pair,
  // but the built route traces segments in order — the actual gap
  // between consecutive axes can be much larger than the connection distance.
  const maxGap = gaps.length > 0 ? Math.max(...gaps.map((g) => g.distanceM)) : 0;
  if (maxGap > MAX_BUILT_GAP_M) return null;

  const infraDistanceM = axisChain.reduce((s, a) => s + a.totalInfraM, 0);
  const gapDistanceM = gaps.reduce((s, g) => s + g.distanceM, 0);
  const totalDistanceM = infraDistanceM + gapDistanceM;
  const infraPercent = totalDistanceM > 0
    ? Math.round((infraDistanceM / totalDistanceM) * 100)
    : 0;

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

  const videos = axisChain.flatMap((a) =>
    a.segments.filter((s) => s.video).map((s) => s.video),
  );

  const archetype = detectArchetype(axisChain, startAnchor, endAnchor);
  const name = generateName(archetype, axisChain, startAnchor, endAnchor);

  const route = {
    name,
    slug: slugify(name),
    archetype,
    startAnchor: { name: startAnchor.name, lat: startAnchor.lat, lng: startAnchor.lng, type: startAnchor.type },
    endAnchor: { name: endAnchor.name, lat: endAnchor.lat, lng: endAnchor.lng, type: endAnchor.type },
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
    compositeScore: 0,
    videos,
    waypointPOIs: [],
    suggestedTags: [],
  };

  const infraScore = infraPercent / 10;
  const condScore = avgConditionScore;
  const gapPenalty = computeGapPenalty(gaps);
  const anchorScoreVal = (startAnchor.anchorScore + endAnchor.anchorScore) / 4;
  const longestAxis = Math.max(...axisChain.map((a) => a.totalInfraM));
  const signatureBonus = longestAxis > 5000 ? 3 : longestAxis > 3000 ? 1.5 : 0;
  const distKm = totalDistanceM / 1000;
  const distBonus = distKm >= 5 && distKm <= 15 ? 1 : distKm >= 15 && distKm <= 40 ? 2 : 0;
  // Loops get a bonus, oval loops get a bigger bonus — they're the signature rides
  let archetypeBonus = 0;
  if (archetype === 'loop') {
    const shape = loopShape(axisChain, totalDistanceM);
    archetypeBonus = shape.isOval ? 5 : 2; // oval loops are gold
  }

  // Coherence bonus: straighter paths look better on the map and are more rideable
  const ratio = detourRatio(axisChain, totalDistanceM);
  const coherenceBonus = ratio < 1.5 ? 2 : ratio < 2.0 ? 1 : ratio < 2.5 ? 0 : -1;

  // Greenery & water bonus: routes through parks, along rivers, or with tree cover
  // are the ones people remember. A bike path through a park is infinitely better
  // than the same distance along a busy road.
  const allSegs = axisChain.flatMap((a) => a.segments);
  const parkSegs = allSegs.filter((s) => s.emplazamiento === 'parque');
  const parkFraction = allSegs.length > 0 ? parkSegs.length / allSegs.length : 0;
  // Smooth scale: 0% = 0, 10% = 1, 25% = 2, 50% = 3, 100% = 4
  const greenBonus = Math.min(parkFraction * 8, 4);

  route.compositeScore = Math.round(
    (infraScore + condScore + anchorScoreVal + signatureBonus + distBonus + archetypeBonus + coherenceBonus + greenBonus - gapPenalty) * 10,
  ) / 10;

  route.suggestedTags = assignTags(route);
  return route;
}

// ---------------------------------------------------------------------------
// Axis-chain-first search
// ---------------------------------------------------------------------------

/**
 * DFS from each axis to discover all viable chains (1 to MAX_CHAIN_AXES).
 * Returns chains as arrays of axis indices. Runs once per start axis.
 */
function discoverChains(startXi, connections, axes) {
  const results = [];
  // DFS with hard budget to prevent explosion on dense graphs
  const stack = [[startXi, [startXi], axes[startXi].totalInfraM, 0]];
  let explored = 0;

  while (stack.length > 0 && explored < MAX_STATES_PER_START) {
    const [current, chain, infraM, gapM] = stack.pop();
    explored++;
    const totalM = infraM + gapM;

    // Record if in distance range
    if (totalM >= MIN_ROUTE_KM * 1000 && totalM <= MAX_ROUTE_KM * 1000) {
      results.push({ chain: [...chain], infraM, gapM });
    }

    if (chain.length >= MAX_CHAIN_AXES) continue;
    if (totalM > MAX_ROUTE_KM * 1000) continue;

    const conns = connections.get(current);
    if (!conns) continue;

    const visited = new Set(chain);
    const currentAxis = axes[current];

    // Direction-aware branching: prefer axes that continue the current
    // direction of travel. This prevents zigzag routes that look nonsensical.
    const candidates = [...conns].filter((n) => !visited.has(n));

    // Reject candidates that overlap the current axis — same name, same start area.
    // Two "ANDRES BELLO" axes starting from Baquedano are variants, not a sequence.
    // But two "COSTANERA SUR" axes where one ends near the other's start ARE sequential.
    const currStart = currentAxis.segments[0].start;
    const currEnd = currentAxis.segments[currentAxis.segments.length - 1].end;
    const nonOverlapping = candidates.filter((n) => {
      if (currentAxis.name !== axes[n].name) return true; // different names can't overlap
      const candStart = axes[n].segments[0].start;
      const candEnd = axes[n].segments[axes[n].segments.length - 1].end;
      // Overlapping: both start from the same point (forking variants)
      if (haversineM(currStart, candStart) < 200) return false;
      // Overlapping: both end at the same point (converging variants)
      if (haversineM(currEnd, candEnd) < 200) return false;
      return true;
    });

    // Score each candidate by direction continuity + axis length + name affinity
    const currentName = currentAxis.name;
    const scored = nonOverlapping.map((n) => {
      const ds = directionScore(currentAxis, axes[n]);
      const lengthBonus = Math.min(axes[n].totalInfraM / 5000, 1); // 0-1
      // Same-name affinity: strongly prefer chaining COSTANERA SUR → COSTANERA SUR
      const nameBonus = (currentName && axes[n].name === currentName) ? 3 : 0;
      return { xi: n, score: ds * 2 + lengthBonus + nameBonus, ds };
    });

    // Filter out backtracking (ds < -0.3) and sort by score
    const nextAxes = scored
      .filter((s) => s.ds > -0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4) // tighter branching for coherent paths
      .map((s) => s.xi);

    for (const next of nextAxes) {
      const currSegs = axes[current].segments;
      const nextSegs = axes[next].segments;
      const { distance: gapDist } = minEndpointDistance(
        currSegs[currSegs.length - 1],
        nextSegs[0],
      );

      const newInfra = infraM + axes[next].totalInfraM;
      const newGap = gapM + gapDist;
      if (newInfra + newGap > MAX_ROUTE_KM * 1000) continue;

      stack.push([next, [...chain, next], newInfra, newGap]);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function stitchTrips(axes, anchors, options = {}) {
  const minAnchorScore = options.minAnchorScore ?? MIN_ANCHOR_SCORE;

  // --- Step 1: Map anchors to nearby axes ---
  const axisAnchors = new Map(); // axis index -> anchors sorted by score

  const usableAnchors = anchors.filter((a) => a.anchorScore >= minAnchorScore);
  console.log(`[trips] ${usableAnchors.length} anchors with score >= ${minAnchorScore}`);

  for (const anchor of usableAnchors) {
    for (let xi = 0; xi < axes.length; xi++) {
      if (anchorToAxisDist(anchor, axes[xi]) <= AXIS_TO_ANCHOR_THRESHOLD_M) {
        if (!axisAnchors.has(xi)) axisAnchors.set(xi, []);
        axisAnchors.get(xi).push(anchor);
      }
    }
  }

  // Sort each axis's anchors by score descending
  for (const [, anchorList] of axisAnchors) {
    anchorList.sort((a, b) => b.anchorScore - a.anchorScore);
  }

  const axesWithAnchors = axisAnchors.size;
  console.log(`[trips] ${axesWithAnchors} axes have nearby anchors`);

  // --- Step 2: Build axis connection graph (lazy, from relevant axes) ---
  const axisConnections = new Map();

  function connectionsFor(i) {
    if (axisConnections.has(i)) return axisConnections.get(i);
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
    return connections;
  }

  // Pre-compute for axes with anchors + 1 hop
  console.log('[trips] Building connection graph...');
  for (const xi of axisAnchors.keys()) {
    const conns = connectionsFor(xi);
    for (const j of conns) connectionsFor(j);
  }
  console.log(`[trips] ${axisConnections.size} axes in connection graph`);

  // --- Step 3: Discover chains from each anchor-bearing axis ---
  console.log('[trips] Discovering axis chains...');
  const candidates = [];
  const chainsSeen = new Set(); // dedup chain fingerprints

  for (const startXi of axisAnchors.keys()) {
    const startAnchors = axisAnchors.get(startXi);
    if (!startAnchors || startAnchors.length === 0) continue;

    const chains = discoverChains(startXi, axisConnections, axes);

    for (const { chain } of chains) {
      // Dedup by sorted axis indices
      const fingerprint = [...chain].sort().join(',');
      if (chainsSeen.has(fingerprint)) continue;
      chainsSeen.add(fingerprint);

      const endXi = chain[chain.length - 1];
      const endAnchors = axisAnchors.get(endXi);
      if (!endAnchors || endAnchors.length === 0) continue;

      const axisChain = chain.map((xi) => axes[xi]);

      // Reject geographically incoherent chains
      const infraM = axisChain.reduce((s, a) => s + a.totalInfraM, 0);
      const ratio = detourRatio(axisChain, infraM);
      if (ratio > MAX_DETOUR_RATIO) continue;
      if (!gapsAreCoherent(axisChain)) continue;

      // Best anchor near start, best different anchor near end
      const startAnchor = startAnchors[0];
      const endAnchor = endAnchors.find((a) => a.name !== startAnchor.name) || endAnchors[0];

      const route = buildRoute(axisChain, startAnchor, endAnchor);
      if (route) candidates.push(route);
    }
  }

  console.log(`[trips] ${candidates.length} chain candidates`);

  // --- Step 4: Loop routes (chains where last axis connects back to first) ---
  console.log('[trips] Searching loop routes...');
  let loopCount = 0;
  const loopsSeen = new Set();

  for (const startXi of axisAnchors.keys()) {
    const startAnchors = axisAnchors.get(startXi);
    if (!startAnchors || startAnchors.length === 0) continue;

    const chains = discoverChains(startXi, axisConnections, axes);
    for (const { chain } of chains) {
      if (chain.length < 3) continue;

      const endXi = chain[chain.length - 1];
      // Check if end connects back to start
      const endConns = connectionsFor(endXi);
      if (!endConns.has(startXi)) continue;

      const fingerprint = 'loop:' + [...chain].sort().join(',');
      if (loopsSeen.has(fingerprint)) continue;
      loopsSeen.add(fingerprint);

      const axisChain = chain.map((xi) => axes[xi]);

      // Reject loops with large gaps — a 3km gap means it's not a real loop
      const loopGaps = computeGaps(axisChain);
      const maxLoopGap = loopGaps.length > 0 ? Math.max(...loopGaps.map((g) => g.distanceM)) : 0;
      if (maxLoopGap > 2000) continue;

      const anchor = startAnchors[0];
      const loopRoute = buildRoute(axisChain, anchor, anchor);
      if (loopRoute) candidates.push(loopRoute);
      loopCount++;
    }
  }
  console.log(`[trips] ${loopCount} loop candidates`);

  // --- Step 5: Out-and-back for long single axes ---
  console.log('[trips] Adding out-and-back routes...');
  for (let xi = 0; xi < axes.length; xi++) {
    const axis = axes[xi];
    if (axis.totalInfraM < MIN_ROUTE_KM * 1000) continue;
    const nearAnchors = axisAnchors.get(xi);
    if (!nearAnchors || nearAnchors.length === 0) continue;

    if (nearAnchors.length >= 2) {
      const oab = buildRoute([axis], nearAnchors[0], nearAnchors[1]);
      if (oab) candidates.push(oab);
    } else {
      const oab = buildRoute([axis], nearAnchors[0], nearAnchors[0]);
      if (oab) candidates.push(oab);
    }
  }

  console.log(`[trips] ${candidates.length} total candidates`);

  // --- Step 6: Deduplicate ---
  candidates.sort((a, b) => b.compositeScore - a.compositeScore);

  const kept = [];
  for (const route of candidates) {
    const routeSlugs = new Set(route.axes.map((a) => a.slug));
    let dominated = false;
    for (const existing of kept) {
      const existingSlugs = new Set(existing.axes.map((a) => a.slug));
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
