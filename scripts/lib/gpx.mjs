/**
 * GPX 1.1 generator for route proposals.
 *
 * Converts a route object (from trips.mjs) into valid GPX XML
 * with a single track containing all axis segments plus gap connections.
 *
 * Segments are oriented to flow continuously — if a segment's end is
 * closer to the previous segment's end than its start, the coordinates
 * are reversed so the GPX trace doesn't jump back and forth.
 */

import { haversineM } from './geo.mjs';
import { routeGap } from './routing.mjs';

// ---------------------------------------------------------------------------
// Elevation enrichment via Open-Meteo API
// ---------------------------------------------------------------------------

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/elevation';
const BATCH_SIZE = 100;

/**
 * Fetch elevation for an array of [lng, lat] coordinates.
 * Batches into groups of 100 (API limit). Returns null on error.
 */
async function fetchElevations(coords) {
  try {
    const all = [];
    for (let i = 0; i < coords.length; i += BATCH_SIZE) {
      const batch = coords.slice(i, i + BATCH_SIZE);
      const lats = batch.map((c) => c[1]).join(',');
      const lons = batch.map((c) => c[0]).join(',');
      const res = await fetch(`${OPEN_METEO_URL}?latitude=${lats}&longitude=${lons}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        console.warn(`[gpx] elevation API returned ${res.status}`);
        return null;
      }
      const data = await res.json();
      const elev = Array.isArray(data.elevation) ? data.elevation : [data.elevation];
      all.push(...elev);
      // Rate-limit: small delay between batches to avoid throttling
      if (i + BATCH_SIZE < coords.length) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return all;
  } catch (err) {
    console.warn(`[gpx] elevation fetch failed: ${err.message || err}`);
    return null;
  }
}

/**
 * Downsample coords, fetch elevations, interpolate back to full resolution.
 */
async function enrichWithElevation(coords) {
  const maxSamples = 100;
  if (coords.length <= maxSamples) {
    const elevations = await fetchElevations(coords);
    if (!elevations) return coords.map((c) => [...c]);
    return coords.map((c, i) => [c[0], c[1], elevations[i]]);
  }

  // Downsample
  const indices = [];
  for (let i = 0; i < maxSamples; i++) {
    indices.push(Math.round((i * (coords.length - 1)) / (maxSamples - 1)));
  }
  const sampled = indices.map((i) => coords[i]);
  const elevations = await fetchElevations(sampled);
  if (!elevations) return coords.map((c) => [...c]);

  // Interpolate
  const result = coords.map((c) => [c[0], c[1], 0]);
  for (let i = 0; i < indices.length; i++) {
    result[indices[i]][2] = elevations[i];
  }
  for (let s = 0; s < indices.length - 1; s++) {
    const startIdx = indices[s], endIdx = indices[s + 1];
    const startEle = elevations[s], endEle = elevations[s + 1];
    const span = endIdx - startIdx;
    for (let i = startIdx + 1; i < endIdx; i++) {
      result[i][2] = startEle + ((i - startIdx) / span) * (endEle - startEle);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

function escapeXML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Coordinate extraction
// ---------------------------------------------------------------------------

function extractCoords(geometry) {
  if (geometry.type === 'LineString') {
    return geometry.coordinates;
  }
  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.flat();
  }
  return [];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build a GPX 1.1 XML string from a route object.
 *
 * @param {object} route - route object from stitchTrips()
 * @returns {string} valid GPX XML
 */
export async function buildGPX(route) {
  const useGoogleRouting = !process.argv.includes('--no-google-routing') && !!process.env.GOOGLE_DIRECTIONS_API_KEY;
  const name = escapeXML(route.name);
  const allCoords = [];
  let lastCoord = null;

  for (const axis of route.axes) {
    // Determine if this axis should be traversed in reverse order.
    // Compare distance from lastCoord to the axis's "natural start"
    // (first segment's first coord) vs its "natural end" (last segment's
    // last coord). If we're closer to the end, reverse segment order.
    let segments = axis.segments;
    if (lastCoord && segments.length >= 2) {
      const firstCoords = extractCoords(segments[0].geometry);
      const lastSegCoords = extractCoords(segments[segments.length - 1].geometry);
      if (firstCoords.length > 0 && lastSegCoords.length > 0) {
        const axisStart = firstCoords[0];
        const axisEnd = lastSegCoords[lastSegCoords.length - 1];
        if (haversineM(lastCoord, axisEnd) < haversineM(lastCoord, axisStart)) {
          segments = [...segments].reverse();
        }
      }
    }

    for (const seg of segments) {
      let coords = extractCoords(seg.geometry);
      if (coords.length === 0) continue;

      // Orient segment to flow continuously from previous
      if (lastCoord && coords.length >= 2) {
        const distToFirst = haversineM(lastCoord, coords[0]);
        const distToLast = haversineM(lastCoord, coords[coords.length - 1]);
        if (distToLast < distToFirst) {
          coords = [...coords].reverse();
        }
      }

      // Add gap connection points if there's a jump
      if (lastCoord) {
        const gapDist = haversineM(lastCoord, coords[0]);
        if (gapDist > 50) {
          // Try Google bike routing for significant gaps
          if (gapDist > 200 && useGoogleRouting) {
            const gapRoute = await routeGap(lastCoord, coords[0]);
            if (gapRoute && gapRoute.length > 0) {
              for (const pt of gapRoute) allCoords.push(pt);
            } else {
              allCoords.push(lastCoord);
              allCoords.push(coords[0]);
            }
          } else {
            allCoords.push(lastCoord);
            allCoords.push(coords[0]);
          }
        }
      }

      for (const coord of coords) {
        allCoords.push(coord);
      }
      lastCoord = coords[coords.length - 1];
    }
  }

  // Close loop routes: append first point to create a closed circuit
  if (route.archetype === 'loop' && allCoords.length > 2) {
    const first = allCoords[0];
    const last = allCoords[allCoords.length - 1];
    if (haversineM(first, last) > 50) {
      allCoords.push(first);
    }
  }

  // Enrich with elevation from Open-Meteo
  const enriched = await enrichWithElevation(allCoords);

  const trkpts = enriched.map((c) => formatTrkpt(c));

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="whereto.bike">
  <metadata><name>${name}</name></metadata>
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts.join('\n')}
    </trkseg>
  </trk>
</gpx>`;
}

/**
 * Format a single coordinate as a <trkpt> element.
 * @param {Array} coord - [lng, lat] or [lng, lat, ele]
 */
function formatTrkpt(coord) {
  const lat = coord[1];
  const lng = coord[0];
  const ele = coord.length >= 3 ? coord[2] : null;
  const eleTag = ele != null ? `<ele>${ele}</ele>` : '';
  return `      <trkpt lat="${lat}" lon="${lng}">${eleTag}</trkpt>`;
}
