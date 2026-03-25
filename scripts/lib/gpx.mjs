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
export function buildGPX(route) {
  const name = escapeXML(route.name);
  const trkpts = [];
  let lastCoord = null; // track the end of the previous segment

  for (let ai = 0; ai < route.axes.length; ai++) {
    const axis = route.axes[ai];

    for (let si = 0; si < axis.segments.length; si++) {
      const seg = axis.segments[si];
      let coords = extractCoords(seg.geometry);
      if (coords.length === 0) continue;

      // Orient segment to flow continuously from previous
      if (lastCoord && coords.length >= 2) {
        const firstPt = coords[0];
        const lastPt = coords[coords.length - 1];
        const distToFirst = haversineM(lastCoord, firstPt);
        const distToLast = haversineM(lastCoord, lastPt);
        if (distToLast < distToFirst) {
          // Segment is backwards — reverse it
          coords = [...coords].reverse();
        }
      }

      // Add gap connection point if there's a jump
      if (lastCoord) {
        const firstPt = coords[0];
        const gapDist = haversineM(lastCoord, firstPt);
        if (gapDist > 50) {
          // Gap larger than 50m — add explicit gap points
          trkpts.push(formatTrkpt(lastCoord));
          trkpts.push(formatTrkpt(firstPt));
        }
      }

      for (const coord of coords) {
        trkpts.push(formatTrkpt(coord));
      }
      lastCoord = coords[coords.length - 1];
    }
  }

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
