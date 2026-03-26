/**
 * Analyze a GPX route's geography in a digestible format.
 *
 * Usage:
 *   node scripts/lib/analyze-route.mjs <gpx-file> [--reference <google-ref-json>]
 *   node scripts/lib/analyze-route.mjs santiago/routes/ciclovia-pocuro/main.gpx
 *   node scripts/lib/analyze-route.mjs --bike-paths-near <lng>,<lat>,<radius-m>
 *   node scripts/lib/analyze-route.mjs --overlap <gpx-file> <reference-points-json>
 *
 * Outputs:
 *   - Bounding box (lat/lng extent)
 *   - Total distance
 *   - Start/end coordinates
 *   - Bearing (overall direction)
 *   - Kilometer-by-kilometer waypoints (for understanding the corridor)
 *   - Overlap with reference points if provided
 */

import { readFileSync } from 'fs';
import { haversineM } from './geo.mjs';

function parseGPX(gpxText) {
  const pts = [];
  // Match trkpt elements - handles both attribute orders
  const re = /lat="([^"]+)"\s+lon="([^"]+)"/g;
  let m;
  while ((m = re.exec(gpxText)) !== null) {
    pts.push([parseFloat(m[2]), parseFloat(m[1])]);  // [lng, lat]
  }
  return pts;
}

function bearing(from, to) {
  const dLng = to[0] - from[0];
  const dLat = to[1] - from[1];
  const deg = Math.atan2(dLng, dLat) * 180 / Math.PI;
  return (deg + 360) % 360;
}

function bearingLabel(deg) {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return labels[Math.round(deg / 45) % 8];
}

function totalDistance(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1], pts[i]);
  return d;
}

function boundingBox(pts) {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  for (const [lng, lat] of pts) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Sample points every `stepM` meters along the route.
 */
function sampleEveryM(pts, stepM = 1000) {
  const samples = [{ dist: 0, coord: pts[0] }];
  let cum = 0;
  let nextSample = stepM;
  for (let i = 1; i < pts.length; i++) {
    const seg = haversineM(pts[i - 1], pts[i]);
    cum += seg;
    if (cum >= nextSample) {
      samples.push({ dist: Math.round(cum), coord: pts[i] });
      nextSample += stepM;
    }
  }
  // Always include end
  samples.push({ dist: Math.round(cum), coord: pts[pts.length - 1] });
  return samples;
}

/**
 * Compute overlap between a route and reference points.
 */
function computeOverlap(routePts, refPts, thresholdM = 200) {
  const results = [];
  for (let i = 0; i < refPts.length; i++) {
    let minD = Infinity;
    // Sample route points for speed (every 5th point for large routes)
    const step = Math.max(1, Math.floor(routePts.length / 2000));
    for (let j = 0; j < routePts.length; j += step) {
      const d = haversineM(refPts[i], routePts[j]);
      if (d < minD) minD = d;
    }
    // Refine: check neighbors of best match
    results.push({ refIdx: i, coord: refPts[i], distM: Math.round(minD), within: minD <= thresholdM });
  }
  return results;
}

export function analyzeRoute(pts) {
  const dist = totalDistance(pts);
  const bb = boundingBox(pts);
  const b = bearing(pts[0], pts[pts.length - 1]);
  const samples = sampleEveryM(pts, 1000);

  return {
    start: pts[0],
    end: pts[pts.length - 1],
    totalPts: pts.length,
    distanceM: Math.round(dist),
    distanceKm: (dist / 1000).toFixed(1),
    bearing: Math.round(b),
    bearingLabel: bearingLabel(b),
    boundingBox: bb,
    kmSamples: samples,
  };
}

export function formatAnalysis(analysis, name) {
  const lines = [];
  lines.push(`=== ${name || 'Route'} ===`);
  lines.push(`Distance: ${analysis.distanceKm}km (${analysis.totalPts} pts)`);
  lines.push(`Direction: ${analysis.bearingLabel} (${analysis.bearing}°)`);
  lines.push(`Start: [${analysis.start[0].toFixed(4)}, ${analysis.start[1].toFixed(4)}]`);
  lines.push(`End:   [${analysis.end[0].toFixed(4)}, ${analysis.end[1].toFixed(4)}]`);
  lines.push(`Bbox:  lat [${analysis.boundingBox.minLat.toFixed(4)}, ${analysis.boundingBox.maxLat.toFixed(4)}]`);
  lines.push(`       lng [${analysis.boundingBox.minLng.toFixed(4)}, ${analysis.boundingBox.maxLng.toFixed(4)}]`);
  lines.push('');
  lines.push('Km-by-km:');
  for (const s of analysis.kmSamples) {
    const km = (s.dist / 1000).toFixed(1);
    lines.push(`  ${km}km: [${s.coord[0].toFixed(4)}, ${s.coord[1].toFixed(4)}]`);
  }
  return lines.join('\n');
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('analyze-route.mjs')) {
  const args = process.argv.slice(2);

  if (args[0] === '--overlap') {
    // --overlap <gpx-file> <reference-json>
    const gpxFile = args[1];
    const refFile = args[2];
    const thresholdM = parseInt(args[3] || '200');
    const routePts = parseGPX(readFileSync(gpxFile, 'utf8'));
    const refPts = JSON.parse(readFileSync(refFile, 'utf8'));
    const overlap = computeOverlap(routePts, refPts, thresholdM);
    const within = overlap.filter(r => r.within).length;
    console.log(`Overlap: ${within}/${refPts.length} (${Math.round(within / refPts.length * 100)}%) within ${thresholdM}m`);
    const deviations = overlap.filter(r => !r.within).sort((a, b) => b.distM - a.distM);
    if (deviations.length > 0) {
      console.log(`Worst deviations:`);
      for (const d of deviations.slice(0, 5)) {
        console.log(`  pt${d.refIdx}: ${d.distM}m at [${d.coord[0].toFixed(4)}, ${d.coord[1].toFixed(4)}]`);
      }
    }
  } else if (args[0] === '--bike-paths-near') {
    // --bike-paths-near <lng>,<lat>,<radius-m> — find bike path GPX files near a point
    const [lng, lat, radiusStr] = args[1].split(',').map(Number);
    const radiusM = radiusStr || 500;
    const { readdirSync, statSync, existsSync } = await import('fs');
    const routesDir = args[2] || 'santiago/routes';
    const dirs = readdirSync(routesDir).filter(d => {
      try { return statSync(routesDir + '/' + d).isDirectory(); } catch { return false; }
    });
    const results = [];
    for (const dir of dirs) {
      const gpxPath = routesDir + '/' + dir + '/main.gpx';
      if (!existsSync(gpxPath)) continue;
      const gpx = readFileSync(gpxPath, 'utf8');
      const pts = parseGPX(gpx);
      if (pts.length === 0) continue;
      let minD = Infinity;
      const step = Math.max(1, Math.floor(pts.length / 500));
      for (let i = 0; i < pts.length; i += step) {
        const d = haversineM([lng, lat], pts[i]);
        if (d < minD) minD = d;
      }
      if (minD <= radiusM) {
        results.push({ slug: dir, distM: Math.round(minD), nPts: pts.length });
      }
    }
    results.sort((a, b) => a.distM - b.distM);
    console.log(`Bike paths within ${radiusM}m of [${lng}, ${lat}]:`);
    for (const r of results) {
      console.log(`  ${r.slug}: ${r.distM}m (${r.nPts} pts)`);
    }
  } else if (args[0] === '--find-corridor') {
    // --find-corridor <reference-json> <threshold-m> — find all GPX routes overlapping a reference polyline
    const refFile = args[1];
    const thresholdM = parseInt(args[2] || '300');
    const refPts = JSON.parse(readFileSync(refFile, 'utf8'));
    const { readdirSync, statSync, existsSync } = await import('fs');
    const routesDir = args[3] || 'santiago/routes';
    const dirs = readdirSync(routesDir).filter(d => {
      try { return statSync(routesDir + '/' + d).isDirectory(); } catch { return false; }
    });
    const results = [];
    for (const dir of dirs) {
      const gpxPath = routesDir + '/' + dir + '/main.gpx';
      if (!existsSync(gpxPath)) continue;
      const gpx = readFileSync(gpxPath, 'utf8');
      const pts = parseGPX(gpx);
      if (pts.length === 0) continue;

      // Sample route points for speed
      const step = Math.max(1, Math.floor(pts.length / 500));
      const sampled = [];
      for (let i = 0; i < pts.length; i += step) sampled.push(pts[i]);

      let near = 0;
      for (const ref of refPts) {
        let minD = Infinity;
        for (const p of sampled) {
          const d = haversineM(ref, p);
          if (d < minD) minD = d;
        }
        if (minD <= thresholdM) near++;
      }
      if (near > 0) {
        results.push({ slug: dir, near, total: refPts.length, pct: Math.round(near / refPts.length * 100) });
      }
    }
    results.sort((a, b) => b.near - a.near);
    console.log(`Routes overlapping reference (within ${thresholdM}m):`);
    for (const r of results.slice(0, 25)) {
      console.log(`  ${r.slug}: ${r.near}/${r.total} pts (${r.pct}%)`);
    }
  } else {
    // Default: analyze a GPX file
    const gpxFile = args[0];
    if (!gpxFile) {
      console.error('Usage: node analyze-route.mjs <gpx-file>');
      console.error('       node analyze-route.mjs --overlap <gpx> <ref.json> [threshold]');
      console.error('       node analyze-route.mjs --bike-paths-near <lng>,<lat>,<radius>');
      console.error('       node analyze-route.mjs --find-corridor <ref.json> [threshold] [routes-dir]');
      process.exit(1);
    }
    const pts = parseGPX(readFileSync(gpxFile, 'utf8'));
    if (pts.length === 0) {
      console.error('No trackpoints found in ' + gpxFile);
      process.exit(1);
    }
    const analysis = analyzeRoute(pts);
    console.log(formatAnalysis(analysis, gpxFile));
  }
}
