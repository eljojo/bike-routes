#!/usr/bin/env node

/**
 * Fetch a cycling route from Google Directions API and save as reference polyline.
 *
 * Usage:
 *   node scripts/fetch-google-route.mjs <output-file> <origin> <destination> [via1] [via2] ...
 *
 * Coordinates are lat,lng (Google format).
 * Requires GOOGLE_PLACES_API_KEY env var with Directions API enabled.
 *
 * Example (La Reina a Quinta Normal):
 *   node scripts/fetch-google-route.mjs \
 *     scripts/lib/fixtures/google-ref-la-reina.json \
 *     -33.4529,-70.5716 \
 *     -33.4346,-70.6443 \
 *     -33.4522,-70.5589 \
 *     -33.4331,-70.5977 \
 *     -33.4173,-70.6050 \
 *     -33.4327,-70.6511 \
 *     -33.4259,-70.6753
 */

import { writeFileSync } from 'node:fs';

const apiKey = process.env.GOOGLE_PLACES_API_KEY;
if (!apiKey) {
  console.error('GOOGLE_PLACES_API_KEY not set');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('Usage: node fetch-google-route.mjs <output> <origin> <destination> [via...]');
  process.exit(1);
}

const outputFile = args[0];
const origin = args[1];
const destination = args[2];
const viaPoints = args.slice(3);

const params = new URLSearchParams({
  origin,
  destination,
  mode: 'bicycling',
  key: apiKey,
});

if (viaPoints.length > 0) {
  params.set('waypoints', viaPoints.join('|'));
}

console.log(`Fetching cycling route: ${origin} → ${destination} (${viaPoints.length} via points)`);

const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
if (!res.ok) {
  console.error(`API error: ${res.status}`);
  process.exit(1);
}

const data = await res.json();
if (data.status !== 'OK') {
  console.error(`Directions API: ${data.status} — ${data.error_message || ''}`);
  process.exit(1);
}

// Decode polyline from each step
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, byte;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lng / 1e5, lat / 1e5]); // [lng, lat] GeoJSON order
  }
  return points;
}

const allPoints = [];
let totalDistM = 0;
for (const leg of data.routes[0].legs) {
  totalDistM += leg.distance.value;
  for (const step of leg.steps) {
    const decoded = decodePolyline(step.polyline.points);
    for (const pt of decoded) {
      const last = allPoints[allPoints.length - 1];
      if (last && last[0] === pt[0] && last[1] === pt[1]) continue;
      allPoints.push(pt);
    }
  }
}

// Sample to ~100-150 points for a manageable fixture
const step = Math.max(1, Math.floor(allPoints.length / 120));
const sampled = [];
for (let i = 0; i < allPoints.length; i += step) sampled.push(allPoints[i]);
if (sampled[sampled.length - 1] !== allPoints[allPoints.length - 1]) {
  sampled.push(allPoints[allPoints.length - 1]);
}

writeFileSync(outputFile, JSON.stringify(sampled));
console.log(`${allPoints.length} total points, sampled to ${sampled.length}`);
console.log(`Distance: ${(totalDistM / 1000).toFixed(1)}km`);
console.log(`Saved to ${outputFile}`);
