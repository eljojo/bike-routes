#!/usr/bin/env node
/**
 * Generate routes from bikepaths.yml — one route per bike path.
 *
 * For each entry in bikepaths.yml:
 *   1. Fetch geometry from OSM (relation members or name-matched ways)
 *   2. Order segments into a continuous trace
 *   3. Write GPX + index.md + media.yml
 *
 * Usage:
 *   node scripts/generate-from-bikepaths.mjs --city santiago
 */

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { queryOverpass } from './lib/overpass.mjs';
import { haversineM } from './lib/geo.mjs';
import { slugify } from './lib/slugify.mjs';
import { orderWays } from './lib/order-ways.mjs';
import { fetchBikePathWays, generateRoute } from './lib/generate-route.mjs';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--city') args.city = process.argv[++i];
}
if (!args.city) {
  console.error('Usage: node scripts/generate-from-bikepaths.mjs --city <city>');
  process.exit(1);
}

const dataDir = path.resolve('..', args.city);
const bikepathsPath = path.join(dataDir, 'bikepaths.yml');
if (!fs.existsSync(bikepathsPath)) {
  console.error(`No bikepaths.yml found at ${bikepathsPath}`);
  process.exit(1);
}

const { bike_paths } = yaml.load(fs.readFileSync(bikepathsPath, 'utf8'));
console.log(`Loaded ${bike_paths.length} bike paths from ${bikepathsPath}`);

const routesDir = path.join(dataDir, 'routes');

// ---------------------------------------------------------------------------
// Fetch relation geometry from Overpass
// ---------------------------------------------------------------------------
// Build GPX from ordered ways
// ---------------------------------------------------------------------------

function buildGPX(name, input) {
  // Accept flat Array<way> or segmented Array<Array<way>>
  let segments;
  if (input.length === 0) {
    segments = [[]];
  } else if (input[0].geometry) {
    // Flat array of ways — wrap in single segment
    segments = [input];
  } else {
    // Already segmented
    segments = input;
  }

  const escName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const trksegs = [];
  let totalDistM = 0;

  for (const segment of segments) {
    if (segment.length === 0) continue;

    // Orient ways and collect coords within this segment
    const allCoords = [];
    let lastCoord = null;

    for (const way of segment) {
      let coords = way.geometry.map(p => [p.lon, p.lat]);

      if (way._reversed != null) {
        if (way._reversed) coords = [...coords].reverse();
      } else if (lastCoord && coords.length >= 2) {
        const dFirst = haversineM(lastCoord, coords[0]);
        const dLast = haversineM(lastCoord, coords[coords.length - 1]);
        if (dLast < dFirst) coords = [...coords].reverse();
      }

      for (const c of coords) allCoords.push(c);
      lastCoord = coords[coords.length - 1];
    }

    if (allCoords.length === 0) continue;

    // Densify sparse sections within segment
    const densified = [allCoords[0]];
    for (let i = 1; i < allCoords.length; i++) {
      const gap = haversineM(allCoords[i - 1], allCoords[i]);
      if (gap > 80) {
        const steps = Math.ceil(gap / 50);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          densified.push([
            allCoords[i - 1][0] + (allCoords[i][0] - allCoords[i - 1][0]) * t,
            allCoords[i - 1][1] + (allCoords[i][1] - allCoords[i - 1][1]) * t,
          ]);
        }
      }
      densified.push(allCoords[i]);
    }

    // Segment distance
    for (let i = 1; i < densified.length; i++) {
      totalDistM += haversineM(densified[i - 1], densified[i]);
    }

    const trkpts = densified.map(c =>
      `      <trkpt lat="${c[1]}" lon="${c[0]}"></trkpt>`
    );

    trksegs.push(`    <trkseg>\n${trkpts.join('\n')}\n    </trkseg>`);
  }

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="whereto.bike">
  <metadata><name>${escName}</name></metadata>
  <trk>
    <name>${escName}</name>
${trksegs.join('\n')}
  </trk>
</gpx>`;

  return { gpx, distanceKm: Math.round(totalDistM / 100) / 10 };
}

// Index bike paths by slug for combined route lookups
const bpBySlug = new Map();
for (const bp of bike_paths) {
  bpBySlug.set(slugify(bp.name), bp);
}

// ---------------------------------------------------------------------------
// Main — Pass 1: individual bike path routes
// ---------------------------------------------------------------------------

let generated = 0;
let failed = 0;

for (const bp of bike_paths) {
  const slug = slugify(bp.name);
  const routeDir = path.join(routesDir, slug);

  try {
    const ways = await fetchBikePathWays(bp);

    if (ways.length === 0) {
      console.log(`  SKIP ${slug}: no OSM ways found`);
      failed++;
      continue;
    }

    const { gpx, distanceKm } = buildGPX(bp.name, ways);

    fs.mkdirSync(routeDir, { recursive: true });
    fs.writeFileSync(path.join(routeDir, 'main.gpx'), gpx);

    // Idempotent: if index.md exists, only update GPX-derived fields
    // (distance_km, variants distance). Preserve everything else
    // (description, tags, waypoints, status, etc.)
    // Collect unique video URLs from catastro segments
    const videoUrls = [...new Set(
      (bp.segments || []).map(s => s.video).filter(Boolean)
    )];
    const videoBody = videoUrls.length > 0
      ? '\n' + videoUrls.join('\n') + '\n'
      : '';

    const mdPath = path.join(routeDir, 'index.md');
    if (fs.existsSync(mdPath)) {
      const raw = fs.readFileSync(mdPath, 'utf8');
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
      if (fmMatch) {
        const existing = yaml.load(fmMatch[1]);
        existing.distance_km = distanceKm;
        existing.updated_at = new Date().toISOString().split('T')[0];
        if (existing.variants?.[0]) existing.variants[0].distance_km = distanceKm;
        // Preserve hand-written body; regenerate if body is empty or only video URLs
        const existingBody = (fmMatch[2] || '').trim();
        const isOnlyVideos = existingBody === '' || existingBody.split('\n').every(
          line => line.trim() === '' || line.trim().startsWith('https://youtu.be/') || line.trim().startsWith('https://www.youtube.com/')
        );
        const body = isOnlyVideos ? videoBody : fmMatch[2] || '';
        const md = `---\n${yaml.dump(existing, { lineWidth: -1 })}---\n${body}`;
        fs.writeFileSync(mdPath, md);
      }
    } else {
      const fm = {
        name: bp.name,
        status: 'published',
        distance_km: distanceKm,
        tags: ['bike path'],
        created_at: new Date().toISOString().split('T')[0],
        updated_at: new Date().toISOString().split('T')[0],
        variants: [{ name: bp.name, gpx: 'main.gpx', distance_km: distanceKm }],
      };
      fs.writeFileSync(mdPath, `---\n${yaml.dump(fm, { lineWidth: -1 })}---\n${videoBody}`);
    }

    if (!fs.existsSync(path.join(routeDir, 'media.yml'))) {
      fs.writeFileSync(path.join(routeDir, 'media.yml'), '[]\n');
    }

    console.log(`  ${slug} (${distanceKm} km, ${ways.length} ways)`);
    generated++;
  } catch (err) {
    console.error(`  FAIL ${slug}: ${err.message}`);
    failed++;
  }
}

console.log(`\n${generated} bike path routes generated, ${failed} failed.`);

// ---------------------------------------------------------------------------
// Pass 2: combined routes (routes with waypoints in frontmatter)
// ---------------------------------------------------------------------------

let combined = 0;
let combinedFailed = 0;

if (fs.existsSync(routesDir)) {
  for (const slug of fs.readdirSync(routesDir)) {
    const mdPath = path.join(routesDir, slug, 'index.md');
    if (!fs.existsSync(mdPath)) continue;
    const raw = fs.readFileSync(mdPath, 'utf8');
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)/);
    if (!fmMatch) continue;
    const fm = yaml.load(fmMatch[1]);
    if (!fm.waypoints || !Array.isArray(fm.waypoints) || fm.waypoints.length === 0) continue;

    try {
      const { segments, resolved } = await generateRoute({
        waypoints: fm.waypoints,
        dataDir,
        bikePaths: bike_paths,
      });

      if (segments.length === 0 || (segments.length === 1 && segments[0].length === 0)) {
        console.log(`  SKIP combined ${slug}: no ways resolved`);
        combinedFailed++;
        continue;
      }

      const { gpx, distanceKm } = buildGPX(fm.name || slug, segments);
      const routeDir = path.join(routesDir, slug);
      fs.writeFileSync(path.join(routeDir, 'main.gpx'), gpx);

      // Update distance in frontmatter
      fm.distance_km = distanceKm;
      fm.updated_at = new Date().toISOString().split('T')[0];
      if (fm.variants?.[0]) fm.variants[0].distance_km = distanceKm;
      const md = `---\n${yaml.dump(fm, { lineWidth: -1 })}---\n${fmMatch[2] || ''}`;
      fs.writeFileSync(mdPath, md);

      console.log(`  COMBINED ${slug} (${distanceKm} km, ${resolved.join(' + ')})`);
      combined++;
    } catch (err) {
      console.error(`  FAIL combined ${slug}: ${err.message}`);
      combinedFailed++;
    }
  }
}

console.log(`${combined} combined routes generated, ${combinedFailed} failed.`);
console.log(`\nDone.`);
