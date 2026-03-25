/**
 * Google Directions API cycling router with file-based caching.
 *
 * Used as a last pass to fill gaps between disconnected axes with
 * actual rideable paths instead of straight lines.
 *
 * Requires GOOGLE_DIRECTIONS_API_KEY environment variable.
 * Skipped with --no-google-routing flag or missing API key.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '..', '.cache', 'routing');
const DIRECTIONS_API = 'https://maps.googleapis.com/maps/api/directions/json';

/**
 * Round coordinate to 5 decimal places for cache key (~1m precision).
 */
function roundCoord(n) {
  return Math.round(n * 100000) / 100000;
}

function cacheKey(from, to) {
  return `${roundCoord(from[1])},${roundCoord(from[0])}_${roundCoord(to[1])},${roundCoord(to[0])}`;
}

/**
 * Route between two [lng, lat] points using Google Directions (bicycling mode).
 * Returns array of [lng, lat] coordinates, or null if routing fails/unavailable.
 *
 * Results are cached to disk to avoid redundant API calls.
 */
export async function routeGap(from, to) {
  const apiKey = process.env.GOOGLE_DIRECTIONS_API_KEY;
  if (!apiKey) return null;

  mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKey(from, to);
  const cachePath = join(CACHE_DIR, `${key}.json`);

  // Check cache
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    return cached.points;
  }

  try {
    const origin = `${from[1]},${from[0]}`; // lat,lng for Google
    const destination = `${to[1]},${to[0]}`;
    const params = new URLSearchParams({
      origin,
      destination,
      mode: 'bicycling',
      key: apiKey,
    });

    const res = await fetch(`${DIRECTIONS_API}?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`[routing] Google API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (data.status !== 'OK') {
      // Cache the failure too so we don't retry
      writeFileSync(cachePath, JSON.stringify({ points: null }), 'utf8');
      return null;
    }

    // Decode polyline from each step
    const points = [];
    for (const leg of data.routes[0].legs) {
      for (const step of leg.steps) {
        const decoded = decodePolyline(step.polyline.points);
        for (const [lat, lng] of decoded) {
          const last = points[points.length - 1];
          if (last && last[0] === lng && last[1] === lat) continue;
          points.push([lng, lat]); // [lng, lat] to match GeoJSON order
        }
      }
    }

    writeFileSync(cachePath, JSON.stringify({ points }), 'utf8');
    console.log(`[routing] Cached gap route: ${key} (${points.length} points)`);
    return points;
  } catch (err) {
    console.warn(`[routing] Failed: ${err.message}`);
    return null;
  }
}

/**
 * Decode a Google encoded polyline string.
 * Returns array of [lat, lng] pairs.
 */
function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}
