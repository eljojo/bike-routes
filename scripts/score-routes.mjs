#!/usr/bin/env node
/**
 * Route quality scorer — walks every GPX in a city and scores each route
 * across multiple dimensions. Use to compare algorithm versions and detect
 * regressions.
 *
 * Usage:
 *   node scripts/score-routes.mjs santiago
 *   node scripts/score-routes.mjs ottawa
 *   node scripts/score-routes.mjs santiago ottawa   # compare both
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { queryOverpass } from './lib/overpass.mjs';

const cities = process.argv.slice(2);
if (cities.length === 0) {
  console.error('Usage: node scripts/score-routes.mjs <city> [city2 ...]');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function haversineM([lng1, lat1], [lng2, lat2]) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearing([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function bearingDiff(a, b) {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------------------------------------------------------------------------
// GPX parser
// ---------------------------------------------------------------------------

function parseGPX(gpxContent) {
  const pts = [];
  for (const m of gpxContent.matchAll(/lat="([^"]+)" lon="([^"]+)"/g)) {
    pts.push([parseFloat(m[2]), parseFloat(m[1])]); // [lng, lat]
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Load places for a city
// ---------------------------------------------------------------------------

function loadPlaces(cityDir) {
  const placesDir = join(cityDir, 'places');
  if (!existsSync(placesDir)) return [];
  return readdirSync(placesDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const raw = readFileSync(join(placesDir, f), 'utf8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) return null;
      const data = yaml.load(fm[1]);
      if (!data.lat || !data.lng) return null;
      return { name: data.name, lat: data.lat, lng: data.lng, category: data.category };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Scoring dimensions
// ---------------------------------------------------------------------------

/**
 * 1. TRACE SMOOTHNESS — detect sharp turns and walkbacks
 *    Walks the GPX point by point, computes bearing changes.
 *    - Sharp turns: bearing change > 120° between consecutive segments > 50m
 *    - Walkbacks: moving > 200m opposite to the overall route direction
 *    Score: 0-100 (100 = perfectly smooth)
 */
function scoreSmoothnessAndWalkbacks(pts) {
  if (pts.length < 3) return { smoothness: 100, walkbacks: 0, sharpTurns: 0 };

  let sharpTurns = 0;
  let walkbacks = 0;
  let prevBearing = null;

  // Overall direction for walkback detection
  const overallBearing = bearing(pts[0], pts[pts.length - 1]);
  const isLoop = haversineM(pts[0], pts[pts.length - 1]) < 2000;

  // For loops, use angle-from-centroid walkback detection
  let cx = 0, cy = 0;
  if (isLoop) {
    for (const [lng, lat] of pts) { cx += lng; cy += lat; }
    cx /= pts.length; cy /= pts.length;
  }

  let maxProjection = -Infinity;

  for (let i = 1; i < pts.length; i++) {
    const d = haversineM(pts[i - 1], pts[i]);
    if (d < 30) continue; // skip tiny steps

    const b = bearing(pts[i - 1], pts[i]);

    // Sharp turn detection
    if (prevBearing !== null && d > 50) {
      const turn = bearingDiff(prevBearing, b);
      if (turn > 120) sharpTurns++;
    }
    prevBearing = b;

    // Walkback detection
    if (!isLoop) {
      // One-way: project onto overall direction
      const dx = pts[i][0] - pts[0][0];
      const dy = pts[i][1] - pts[0][1];
      const ox = pts[pts.length - 1][0] - pts[0][0];
      const oy = pts[pts.length - 1][1] - pts[0][1];
      const lenSq = ox * ox + oy * oy;
      if (lenSq > 1e-12) {
        const proj = ((dx * ox + dy * oy) / Math.sqrt(lenSq)) * 111320;
        if (proj > maxProjection) maxProjection = proj;
        if (maxProjection - proj > 200) walkbacks++;
      }
    }
  }

  // For loops: count angular reversals
  if (isLoop) {
    const sampleStep = Math.max(1, Math.floor(pts.length / 100));
    let lastAngleDir = 0;
    let prevAngle = null;
    for (let i = 0; i < pts.length; i += sampleStep) {
      const angle = Math.atan2(pts[i][0] - cx, pts[i][1] - cy) * 180 / Math.PI;
      if (prevAngle !== null) {
        let delta = angle - prevAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        if (Math.abs(delta) > 5) {
          const dir = delta > 0 ? 1 : -1;
          if (lastAngleDir !== 0 && dir !== lastAngleDir && Math.abs(delta) > 15) {
            walkbacks++;
          }
          lastAngleDir = dir;
        }
      }
      prevAngle = angle;
    }
  }

  const totalSteps = pts.length - 1;
  const smoothness = Math.max(0, 100 - (sharpTurns / Math.max(1, totalSteps)) * 2000);

  return { smoothness: Math.round(smoothness), walkbacks, sharpTurns };
}

/**
 * 2. GAP QUALITY — detect straight-line interpolation (missing routing data)
 *    Walks the GPX and finds sequences of perfectly evenly-spaced points
 *    on a straight line. These are our interpolated gaps.
 *    Score: percentage of route that is real data (not interpolated)
 */
function scoreGapQuality(pts) {
  if (pts.length < 3) return { realDataPct: 100, interpolatedSegments: 0, interpolatedDistM: 0 };

  let interpolatedDist = 0;
  let interpolatedSegs = 0;
  let totalDist = 0;
  let inInterpolation = false;
  let interpStart = -1;

  for (let i = 1; i < pts.length; i++) {
    const d = haversineM(pts[i - 1], pts[i]);
    totalDist += d;

    // Detect interpolation: points exactly ~50m apart on a perfect line
    // (our densification uses 50m intervals)
    if (i >= 2 && d > 40 && d < 60) {
      const prevD = haversineM(pts[i - 2], pts[i - 1]);
      if (prevD > 40 && prevD < 60) {
        // Check collinearity: bearing between consecutive pairs should be identical
        const b1 = bearing(pts[i - 2], pts[i - 1]);
        const b2 = bearing(pts[i - 1], pts[i]);
        if (bearingDiff(b1, b2) < 2) {
          if (!inInterpolation) {
            inInterpolation = true;
            interpStart = i - 2;
            interpolatedSegs++;
          }
          interpolatedDist += d;
          continue;
        }
      }
    }

    if (inInterpolation) {
      inInterpolation = false;
    }
  }

  const realDataPct = totalDist > 0
    ? Math.round((1 - interpolatedDist / totalDist) * 100)
    : 100;

  return { realDataPct, interpolatedSegments: interpolatedSegs, interpolatedDistM: Math.round(interpolatedDist) };
}

/**
 * 3. POI PROXIMITY — how many places does the route pass within 500m?
 *    More POIs = more interesting ride with places to stop.
 */
function scorePOIProximity(pts, places) {
  if (places.length === 0) return { poisNearby: 0, poisPer10km: 0 };

  // Sample route every ~200m
  const sampleStep = Math.max(1, Math.floor(pts.length / 200));
  const sampled = [];
  for (let i = 0; i < pts.length; i += sampleStep) sampled.push(pts[i]);

  let totalDist = 0;
  for (let i = 1; i < pts.length; i++) totalDist += haversineM(pts[i - 1], pts[i]);

  const nearbyPOIs = new Set();
  for (const place of places) {
    const placeCoord = [place.lng, place.lat];
    for (const pt of sampled) {
      if (haversineM(pt, placeCoord) < 500) {
        nearbyPOIs.add(place.name);
        break;
      }
    }
  }

  const distKm = totalDist / 1000;
  return {
    poisNearby: nearbyPOIs.size,
    poisPer10km: distKm > 0 ? Math.round((nearbyPOIs.size / distKm) * 10 * 10) / 10 : 0,
  };
}

/**
 * 4. JUMP SCORE — large gaps in the trace (> various thresholds)
 */
function scoreJumps(pts) {
  const jumps = { over500m: 0, over1km: 0, over2km: 0, worstM: 0 };
  for (let i = 1; i < pts.length; i++) {
    const d = haversineM(pts[i - 1], pts[i]);
    if (d > 500) jumps.over500m++;
    if (d > 1000) jumps.over1km++;
    if (d > 2000) jumps.over2km++;
    if (d > jumps.worstM) jumps.worstM = Math.round(d);
  }
  return jumps;
}

/**
 * 5. POINT DENSITY — points per km (sparse = low GPS quality)
 */
function scoreDensity(pts) {
  let totalDist = 0;
  for (let i = 1; i < pts.length; i++) totalDist += haversineM(pts[i - 1], pts[i]);
  const distKm = totalDist / 1000;
  return {
    points: pts.length,
    distKm: Math.round(distKm * 10) / 10,
    pointsPerKm: distKm > 0 ? Math.round(pts.length / distKm) : 0,
  };
}

/**
 * 6. LOOP CLOSURE — for loop routes, how far apart are start and end?
 */
function scoreLoopClosure(pts, tags) {
  const isLoop = tags.includes('loop');
  if (!isLoop) return null;
  const closureDist = Math.round(haversineM(pts[0], pts[pts.length - 1]));
  return { closureDistM: closureDist, closed: closureDist < 500 };
}

/**
 * 7. INFRASTRUCTURE REALITY CHECK — query Overpass to see what's actually
 *    under the route. For sampled points along the trace:
 *    - Is there a cycleway/bike path within 50m? (oasis)
 *    - Is there a major road (primary/secondary/trunk) within 50m? (car stress)
 *    - Is there a park/garden/water within 200m? (green/scenic)
 *    Returns fractions of the route in each category.
 */
async function fetchInfraContext(bounds) {
  const [s, w, n, e] = bounds;
  const bbox = `${s},${w},${n},${e}`;

  // Fetch cycleways, major roads, and green spaces in one go
  const query = `
[out:json][timeout:60];
(
  way["highway"="cycleway"](${bbox});
  way["cycleway"~"track|lane"](${bbox});
  way["bicycle"="designated"](${bbox});
  way["highway"~"primary|secondary|trunk|motorway"](${bbox});
  way["leisure"~"park|garden"](${bbox});
  way["natural"="water"](${bbox});
  way["waterway"~"river|canal"](${bbox});
);
out geom tags;
`.trim();

  const data = await queryOverpass(query);
  const elements = data.elements ?? [];

  // Build spatial lookup: grid of 0.002° cells (~200m)
  const GRID = 0.002;
  const grid = { bike: new Map(), car: new Map(), green: new Map() };

  for (const el of elements) {
    if (!el.geometry) continue;
    const tags = el.tags || {};
    let category = null;
    if (tags.highway === 'cycleway' || tags.cycleway || tags.bicycle === 'designated') {
      category = 'bike';
    } else if (['primary', 'secondary', 'trunk', 'motorway'].includes(tags.highway)) {
      category = 'car';
    } else if (tags.leisure || tags.natural === 'water' || tags.waterway) {
      category = 'green';
    }
    if (!category) continue;

    for (const pt of el.geometry) {
      const key = `${Math.floor(pt.lat / GRID)},${Math.floor(pt.lon / GRID)}`;
      if (!grid[category].has(key)) grid[category].set(key, []);
      grid[category].get(key).push([pt.lon, pt.lat]);
    }
  }

  return grid;
}

function scoreInfraReality(pts, grid) {
  // Sample every ~100m
  const step = Math.max(1, Math.floor(pts.length / 200));
  let onBikePath = 0, nearCars = 0, nearGreen = 0, sampled = 0;
  const GRID = 0.002;

  for (let i = 0; i < pts.length; i += step) {
    sampled++;
    const [lng, lat] = pts[i];
    const cellKey = `${Math.floor(lat / GRID)},${Math.floor(lng / GRID)}`;

    // Check 3x3 neighborhood
    let foundBike = false, foundCar = false, foundGreen = false;
    for (let dlat = -1; dlat <= 1 && !(foundBike && foundCar && foundGreen); dlat++) {
      for (let dlng = -1; dlng <= 1 && !(foundBike && foundCar && foundGreen); dlng++) {
        const key = `${Math.floor(lat / GRID) + dlat},${Math.floor(lng / GRID) + dlng}`;

        if (!foundBike && grid.bike.has(key)) {
          for (const p of grid.bike.get(key)) {
            if (haversineM(pts[i], p) < 50) { foundBike = true; break; }
          }
        }
        if (!foundCar && grid.car.has(key)) {
          for (const p of grid.car.get(key)) {
            if (haversineM(pts[i], p) < 50) { foundCar = true; break; }
          }
        }
        if (!foundGreen && grid.green.has(key)) {
          for (const p of grid.green.get(key)) {
            if (haversineM(pts[i], p) < 200) { foundGreen = true; break; }
          }
        }
      }
    }

    if (foundBike) onBikePath++;
    if (foundCar) nearCars++;
    if (foundGreen) nearGreen++;
  }

  return {
    bikePathPct: sampled > 0 ? Math.round((onBikePath / sampled) * 100) : 0,
    carStressPct: sampled > 0 ? Math.round((nearCars / sampled) * 100) : 0,
    greenPct: sampled > 0 ? Math.round((nearGreen / sampled) * 100) : 0,
  };
}

/**
 * 8. RIDEABILITY — "would a human actually ride this path?"
 *    Measures wasted distance: how much of the route is spent going
 *    somewhere you'll backtrack from? A perfect route has efficiency
 *    close to 1.0 (every meter gets you closer to the end).
 *    A route that goes east 2km then west 2km has efficiency ~0.
 *
 *    For loops: measures how monotonically the angle from centroid
 *    progresses. A perfect O scores 100, a C that goes back scores 0.
 *
 *    Score: 0-100 (100 = every meter makes progress)
 */
function scoreRideability(pts) {
  if (pts.length < 3) return { rideability: 100, efficiency: 1, wastedDistM: 0 };

  let totalDist = 0;
  for (let i = 1; i < pts.length; i++) totalDist += haversineM(pts[i - 1], pts[i]);

  const crowFlies = haversineM(pts[0], pts[pts.length - 1]);
  const isLoop = crowFlies < Math.max(2000, totalDist * 0.15);

  if (isLoop) {
    // For loops: measure angular monotonicity
    // A perfect loop has angle from centroid always increasing (or decreasing)
    // Back-and-forth = wasted angular distance
    let cx = 0, cy = 0;
    for (const [lng, lat] of pts) { cx += lng; cy += lat; }
    cx /= pts.length; cy /= pts.length;

    const step = Math.max(1, Math.floor(pts.length / 100));
    let forwardArc = 0, backwardArc = 0;
    let prevAngle = null;
    let dominant = 0; // +1 or -1 (CW vs CCW)

    // First pass: determine dominant direction
    for (let i = 0; i < pts.length; i += step) {
      const angle = Math.atan2(pts[i][0] - cx, pts[i][1] - cy) * 180 / Math.PI;
      if (prevAngle !== null) {
        let delta = angle - prevAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        dominant += delta > 0 ? 1 : -1;
      }
      prevAngle = angle;
    }
    const expectedDir = dominant >= 0 ? 1 : -1;

    // Second pass: measure forward vs backward arc
    prevAngle = null;
    for (let i = 0; i < pts.length; i += step) {
      const angle = Math.atan2(pts[i][0] - cx, pts[i][1] - cy) * 180 / Math.PI;
      if (prevAngle !== null) {
        let delta = angle - prevAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        if (Math.abs(delta) > 2) {
          if ((delta > 0 ? 1 : -1) === expectedDir) forwardArc += Math.abs(delta);
          else backwardArc += Math.abs(delta);
        }
      }
      prevAngle = angle;
    }

    const totalArc = forwardArc + backwardArc;
    const efficiency = totalArc > 0 ? forwardArc / totalArc : 1;
    const wastedDistM = Math.round(totalDist * (1 - efficiency));
    const rideability = Math.round(efficiency * 100);

    return { rideability, efficiency: Math.round(efficiency * 100) / 100, wastedDistM };
  }

  // For one-way: measure how much distance is "wasted" going backwards
  // Project each point onto the start→end line. The ideal route has
  // monotonically increasing projection. Any decrease is wasted.
  const ox = pts[pts.length - 1][0] - pts[0][0];
  const oy = pts[pts.length - 1][1] - pts[0][1];
  const lenSq = ox * ox + oy * oy;
  if (lenSq < 1e-12) return { rideability: 0, efficiency: 0, wastedDistM: Math.round(totalDist) };

  let maxProj = -Infinity;
  let wastedDist = 0;
  let prevProj = 0;

  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i][0] - pts[0][0];
    const dy = pts[i][1] - pts[0][1];
    const proj = (dx * ox + dy * oy) / Math.sqrt(lenSq) * 111320;

    if (proj > maxProj) maxProj = proj;
    if (i > 0 && proj < prevProj) {
      wastedDist += haversineM(pts[i - 1], pts[i]);
    }
    prevProj = proj;
  }

  const efficiency = totalDist > 0 ? Math.max(0, 1 - (wastedDist * 2 / totalDist)) : 1;
  const rideability = Math.round(efficiency * 100);

  return { rideability, efficiency: Math.round(efficiency * 100) / 100, wastedDistM: Math.round(wastedDist) };
}

/**
 * 9. SHAPE DESCRIPTION — trace the route in directional blocks
 *    Returns a compact string like "→E →E ↑N ↑N ←W ←W" showing
 *    the general direction of each ~1km block.
 */
function describeShape(pts) {
  if (pts.length < 2) return '?';

  // Compute total distance, then divide into ~1km blocks
  let totalDist = 0;
  for (let i = 1; i < pts.length; i++) totalDist += haversineM(pts[i - 1], pts[i]);
  const blockCount = Math.max(2, Math.min(12, Math.round(totalDist / 1000)));
  const blockSize = Math.floor(pts.length / blockCount);

  const dirs = [];
  for (let b = 0; b < blockCount; b++) {
    const startIdx = b * blockSize;
    const endIdx = Math.min((b + 1) * blockSize, pts.length - 1);
    const dlat = (pts[endIdx][1] - pts[startIdx][1]) * 111320;
    const dlng = (pts[endIdx][0] - pts[startIdx][0]) * 111320 * Math.cos(pts[startIdx][1] * Math.PI / 180);
    const d = Math.sqrt(dlat * dlat + dlng * dlng);
    if (d < 50) { dirs.push('·'); continue; }

    const angle = Math.atan2(dlng, dlat) * 180 / Math.PI;
    if (angle >= -22.5 && angle < 22.5) dirs.push('↑N');
    else if (angle >= 22.5 && angle < 67.5) dirs.push('↗NE');
    else if (angle >= 67.5 && angle < 112.5) dirs.push('→E');
    else if (angle >= 112.5 && angle < 157.5) dirs.push('↘SE');
    else if (angle >= 157.5 || angle < -157.5) dirs.push('↓S');
    else if (angle >= -157.5 && angle < -112.5) dirs.push('↙SW');
    else if (angle >= -112.5 && angle < -67.5) dirs.push('←W');
    else dirs.push('↖NW');
  }

  return dirs.join(' ');
}

// ---------------------------------------------------------------------------
// Composite score
// ---------------------------------------------------------------------------

function compositeScore(scores) {
  // Weight each dimension. Higher = better route.
  let score = 0;

  // Smoothness: 0-100 → 0-25 points
  score += scores.smoothness.smoothness * 0.25;

  // No walkbacks: -5 per walkback
  score -= scores.smoothness.walkbacks * 5;

  // Real data: 0-100% → 0-20 points
  score += scores.gapQuality.realDataPct * 0.2;

  // POIs: up to 15 points (3 per POI per 10km, capped)
  score += Math.min(scores.pois.poisPer10km * 3, 15);

  // No jumps: -10 per jump >1km, -5 per jump >500m
  score -= scores.jumps.over1km * 10;
  score -= (scores.jumps.over500m - scores.jumps.over1km) * 5;

  // Density: up to 10 points (good = 50+ pts/km)
  score += Math.min(scores.density.pointsPerKm / 5, 10);

  // Loop closure: +5 if closed, -10 if open loop
  if (scores.loopClosure) {
    score += scores.loopClosure.closed ? 5 : -10;
  }

  // Rideability: the biggest factor. A route that backtracks is not rideable.
  // 0-100 → 0-30 points. A route with rideability 0 gets -30.
  if (scores.rideability) {
    score += (scores.rideability.rideability - 50) * 0.6; // 100→+30, 50→0, 0→-30
  }

  // Infrastructure reality: oasis vs car stress
  if (scores.infra) {
    score += scores.infra.bikePathPct * 0.15;  // up to 15 pts for 100% bike path
    score -= scores.infra.carStressPct * 0.1;   // -10 pts for 100% near cars
    score += scores.infra.greenPct * 0.1;        // up to 10 pts for 100% green
  }

  return Math.round(score * 10) / 10;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

for (const city of cities) {
  const cityDir = join(process.cwd(), city);
  if (!existsSync(cityDir)) {
    console.error(`City directory not found: ${cityDir}`);
    continue;
  }

  const routesDir = join(cityDir, 'routes');
  if (!existsSync(routesDir)) {
    console.error(`No routes/ in ${cityDir}`);
    continue;
  }

  const places = loadPlaces(cityDir);
  const routeDirs = readdirSync(routesDir).filter((d) =>
    existsSync(join(routesDir, d, 'main.gpx'))
  );

  console.log(`\n${'='.repeat(80)}`);
  console.log(`${city.toUpperCase()} — ${routeDirs.length} routes, ${places.length} places`);
  console.log(`${'='.repeat(80)}\n`);

  // Compute bounding box from all routes for infra context
  console.log('Loading GPX data...');
  const allPts = new Map();
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const slug of routeDirs) {
    const pts = parseGPX(readFileSync(join(routesDir, slug, 'main.gpx'), 'utf8'));
    allPts.set(slug, pts);
    for (const [lng, lat] of pts) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }

  // Fetch infrastructure context from Overpass
  console.log('Fetching infrastructure context from Overpass...');
  const pad = 0.005; // ~500m padding
  const infraGrid = await fetchInfraContext([minLat - pad, minLng - pad, maxLat + pad, maxLng + pad]);
  console.log(`  Bike path cells: ${infraGrid.bike.size}, Car road cells: ${infraGrid.car.size}, Green cells: ${infraGrid.green.size}`);

  const allScores = [];

  for (const routeSlug of routeDirs) {
    const mdPath = join(routesDir, routeSlug, 'index.md');
    const pts = allPts.get(routeSlug);
    if (!pts || pts.length < 2) continue;

    // Parse tags from frontmatter
    let tags = [];
    if (existsSync(mdPath)) {
      const md = readFileSync(mdPath, 'utf8');
      const fm = md.match(/^---\n([\s\S]*?)\n---/);
      if (fm) {
        const data = yaml.load(fm[1]);
        tags = data.tags || [];
      }
    }

    const scores = {
      smoothness: scoreSmoothnessAndWalkbacks(pts),
      gapQuality: scoreGapQuality(pts),
      pois: scorePOIProximity(pts, places),
      jumps: scoreJumps(pts),
      density: scoreDensity(pts),
      loopClosure: scoreLoopClosure(pts, tags),
      infra: scoreInfraReality(pts, infraGrid),
      rideability: scoreRideability(pts),
    };
    scores.composite = compositeScore(scores);

    // Generate directional shape description
    const shape = describeShape(pts);

    // Flag specific issues
    const issues = [];
    if (scores.smoothness.walkbacks > 0) issues.push(`${scores.smoothness.walkbacks} walkbacks`);
    if (scores.jumps.over1km > 0) issues.push(`${scores.jumps.over1km} jumps >1km`);
    if (scores.gapQuality.interpolatedSegments > 3) issues.push(`${scores.gapQuality.interpolatedSegments} interpolated gaps`);
    if (scores.infra.bikePathPct < 30) issues.push(`only ${scores.infra.bikePathPct}% on bike path`);
    if (scores.infra.carStressPct > 50) issues.push(`${scores.infra.carStressPct}% near car traffic`);
    if (scores.loopClosure && !scores.loopClosure.closed) issues.push(`loop not closed (${scores.loopClosure.closureDistM}m gap)`);
    if (scores.rideability.rideability < 50) issues.push(`low rideability ${scores.rideability.rideability}% (${Math.round(scores.rideability.wastedDistM/1000*10)/10}km wasted)`);
    if (scores.density.pointsPerKm < 20) issues.push(`sparse (${scores.density.pointsPerKm} pts/km)`);

    allScores.push({ slug: routeSlug, scores, tags, shape, issues });
  }

  // Sort by composite score
  allScores.sort((a, b) => b.scores.composite - a.scores.composite);

  // Print per-route scores
  for (const { slug, scores, shape, issues } of allScores) {
    const s = scores;
    const loopMark = s.loopClosure ? (s.loopClosure.closed ? '○' : '⊘') : ' ';
    const distStr = s.density.distKm + 'km';
    const header = `${loopMark} ${slug} (${distStr})`;
    const scoreLine = `  Score: ${s.composite} | Ride: ${s.rideability.rideability}% | Smooth: ${s.smoothness.smoothness}% | Bike: ${s.infra.bikePathPct}% | Cars: ${s.infra.carStressPct}% | Green: ${s.infra.greenPct}% | POIs: ${s.pois.poisNearby} | Real: ${s.gapQuality.realDataPct}%`;
    const shapeLine = `  Shape: ${shape}`;

    console.log(header);
    console.log(scoreLine);
    console.log(shapeLine);
    if (issues.length > 0) {
      console.log(`  Issues: ${issues.join(', ')}`);
    }
    console.log();
  }

  // City-wide summary
  const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const composites = allScores.map((r) => r.scores.composite);
  const smoothnesses = allScores.map((r) => r.scores.smoothness.smoothness);
  const walkbackRoutes = allScores.filter((r) => r.scores.smoothness.walkbacks > 0).length;
  const jumpRoutes = allScores.filter((r) => r.scores.jumps.over1km > 0).length;
  const realDataPcts = allScores.map((r) => r.scores.gapQuality.realDataPct);
  const poisPer10km = allScores.map((r) => r.scores.pois.poisPer10km);
  const densities = allScores.map((r) => r.scores.density.pointsPerKm);
  const loops = allScores.filter((r) => r.scores.loopClosure);
  const closedLoops = loops.filter((r) => r.scores.loopClosure.closed).length;

  const rideabilities = allScores.map((r) => r.scores.rideability.rideability);
  const lowRideability = allScores.filter((r) => r.scores.rideability.rideability < 50).length;
  const bikePathPcts = allScores.map((r) => r.scores.infra.bikePathPct);
  const carStressPcts = allScores.map((r) => r.scores.infra.carStressPct);
  const greenPcts = allScores.map((r) => r.scores.infra.greenPct);
  const issueRoutes = allScores.filter((r) => r.issues.length > 0);

  console.log(`${'─'.repeat(80)}`);
  console.log(`SUMMARY: ${city.toUpperCase()}`);
  console.log(`${'─'.repeat(80)}`);
  console.log(`  Routes: ${allScores.length}`);
  console.log(`  Composite score: avg=${avg(composites).toFixed(1)}, min=${Math.min(...composites).toFixed(1)}, max=${Math.max(...composites).toFixed(1)}`);
  console.log();
  console.log(`  RIDEABILITY ("does this make sense to ride?")`);
  console.log(`    Avg rideability: ${avg(rideabilities).toFixed(0)}%`);
  console.log(`    Routes below 50%: ${lowRideability}/${allScores.length}`);
  console.log();
  console.log(`  TRACE QUALITY`);
  console.log(`    Smoothness: avg=${avg(smoothnesses).toFixed(0)}%`);
  console.log(`    Routes with walkbacks: ${walkbackRoutes}/${allScores.length}`);
  console.log(`    Routes with jumps >1km: ${jumpRoutes}/${allScores.length}`);
  console.log(`    Real data (not interpolated): avg=${avg(realDataPcts).toFixed(0)}%`);
  console.log(`    Point density: avg=${avg(densities).toFixed(0)} pts/km`);
  console.log();
  console.log(`  OASIS QUALITY`);
  console.log(`    On bike path: avg=${avg(bikePathPcts).toFixed(0)}%`);
  console.log(`    Near car traffic: avg=${avg(carStressPcts).toFixed(0)}%`);
  console.log(`    Near green/water: avg=${avg(greenPcts).toFixed(0)}%`);
  console.log(`    POIs per 10km: avg=${avg(poisPer10km).toFixed(1)}`);
  console.log();
  if (loops.length > 0) {
    console.log(`  LOOPS`);
    console.log(`    Properly closed: ${closedLoops}/${loops.length}`);
    console.log();
  }
  if (issueRoutes.length > 0) {
    console.log(`  ROUTES WITH ISSUES (${issueRoutes.length}/${allScores.length}):`);
    for (const r of issueRoutes) {
      console.log(`    ${r.slug}: ${r.issues.join(', ')}`);
    }
    console.log();
  }
  console.log();
}
