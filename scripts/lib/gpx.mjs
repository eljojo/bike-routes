/**
 * GPX 1.1 generator for route proposals.
 *
 * Converts a route object (from trips.mjs) into valid GPX XML
 * with a single track containing all axis segments plus gap connections.
 */

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

/**
 * Extract all [lng, lat, ele?] coordinates from a geometry object.
 * Handles both LineString and MultiLineString.
 */
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

  for (let ai = 0; ai < route.axes.length; ai++) {
    const axis = route.axes[ai];

    // Add gap connection from previous axis (straight line)
    if (ai > 0) {
      const prevAxis = route.axes[ai - 1];
      const prevSegs = prevAxis.segments;
      const prevLastSeg = prevSegs[prevSegs.length - 1];
      const prevCoords = extractCoords(prevLastSeg.geometry);
      const lastPt = prevCoords[prevCoords.length - 1];

      const currFirstSeg = axis.segments[0];
      const currCoords = extractCoords(currFirstSeg.geometry);
      const firstPt = currCoords[0];

      // Add the two gap points (last of prev, first of current)
      trkpts.push(formatTrkpt(lastPt));
      trkpts.push(formatTrkpt(firstPt));
    }

    // Add all coordinates from each segment in this axis
    for (const seg of axis.segments) {
      const coords = extractCoords(seg.geometry);
      for (const coord of coords) {
        trkpts.push(formatTrkpt(coord));
      }
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
