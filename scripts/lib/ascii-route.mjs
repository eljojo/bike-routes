/**
 * Draw one or two routes as ASCII art on a grid.
 *
 * Usage:
 *   node scripts/lib/ascii-route.mjs <gpx-file>
 *   node scripts/lib/ascii-route.mjs <gpx-file> <reference-json>
 *   node scripts/lib/ascii-route.mjs santiago/routes/ruta-de-los-parques/main.gpx scripts/lib/fixtures/google-ref-ruta-de-los-parques.json
 *
 * The grid is 60 columns wide and auto-scales height to preserve aspect ratio.
 * Route A (GPX) is drawn with *, route B (reference) with o.
 * Overlapping cells show X. Start/end marked with S/E and s/e.
 */

import { readFileSync } from 'fs';

function parseGPX(gpxText) {
  const pts = [];
  const re = /lat="([^"]+)"\s+lon="([^"]+)"/g;
  let m;
  while ((m = re.exec(gpxText)) !== null) {
    pts.push([parseFloat(m[2]), parseFloat(m[1])]);  // [lng, lat]
  }
  return pts;
}

function drawAscii(routeA, routeB, width = 60) {
  // Compute combined bounding box
  const all = [...routeA, ...(routeB || [])];
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lng, lat] of all) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  // Add small padding
  const padLat = (maxLat - minLat) * 0.05 || 0.001;
  const padLng = (maxLng - minLng) * 0.05 || 0.001;
  minLat -= padLat; maxLat += padLat;
  minLng -= padLng; maxLng += padLng;

  // Aspect ratio: lat degrees are ~111km, lng degrees are ~85km at -33°
  const latRange = maxLat - minLat;
  const lngRange = maxLng - minLng;
  const aspectRatio = (latRange * 111) / (lngRange * 85);
  const height = Math.max(10, Math.round(width * aspectRatio * 0.5)); // *0.5 because chars are ~2x tall as wide

  // Create grid
  const grid = Array.from({ length: height }, () => Array(width).fill(' '));

  function toCell(lng, lat) {
    const col = Math.floor((lng - minLng) / (maxLng - minLng) * (width - 1));
    const row = Math.floor((maxLat - lat) / (maxLat - minLat) * (height - 1)); // flip Y
    return [Math.max(0, Math.min(height - 1, row)), Math.max(0, Math.min(width - 1, col))];
  }

  // Draw route B first (reference) — so A overwrites if overlapping
  if (routeB && routeB.length > 0) {
    // Sample to avoid flooding the grid
    const step = Math.max(1, Math.floor(routeB.length / 300));
    for (let i = 0; i < routeB.length; i += step) {
      const [row, col] = toCell(routeB[i][0], routeB[i][1]);
      if (grid[row][col] === ' ') grid[row][col] = 'o';
    }
    // Mark start/end
    const [sr, sc] = toCell(routeB[0][0], routeB[0][1]);
    const [er, ec] = toCell(routeB[routeB.length - 1][0], routeB[routeB.length - 1][1]);
    grid[sr][sc] = 's';
    grid[er][ec] = 'e';
  }

  // Draw route A (generated GPX)
  const stepA = Math.max(1, Math.floor(routeA.length / 300));
  for (let i = 0; i < routeA.length; i += stepA) {
    const [row, col] = toCell(routeA[i][0], routeA[i][1]);
    if (grid[row][col] === 'o' || grid[row][col] === 's' || grid[row][col] === 'e') {
      grid[row][col] = 'X'; // overlap
    } else if (grid[row][col] === ' ') {
      grid[row][col] = '*';
    }
  }
  // Mark start/end of route A
  const [asr, asc] = toCell(routeA[0][0], routeA[0][1]);
  const [aer, aec] = toCell(routeA[routeA.length - 1][0], routeA[routeA.length - 1][1]);
  grid[asr][asc] = 'S';
  grid[aer][aec] = 'E';

  // Render
  const lines = [];
  const border = '+' + '-'.repeat(width) + '+';
  lines.push(border);
  for (const row of grid) {
    lines.push('|' + row.join('') + '|');
  }
  lines.push(border);

  // Legend
  lines.push('');
  if (routeB) {
    lines.push('S/E = generated start/end    s/e = reference start/end');
    lines.push('*   = generated only         o   = reference only        X = overlap');
  } else {
    lines.push('S = start    E = end    * = route');
  }

  return lines.join('\n');
}

/**
 * Draw two routes side by side on separate grids with shared bounding box.
 * Left = reference (Google), Right = generated. Same scale so shapes are directly comparable.
 */
function drawSideBySide(routeA, routeB, halfWidth = 30) {
  const all = [...routeA, ...(routeB || [])];
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lng, lat] of all) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const padLat = (maxLat - minLat) * 0.05 || 0.001;
  const padLng = (maxLng - minLng) * 0.05 || 0.001;
  minLat -= padLat; maxLat += padLat;
  minLng -= padLng; maxLng += padLng;

  const latRange = maxLat - minLat;
  const lngRange = maxLng - minLng;
  const aspectRatio = (latRange * 111) / (lngRange * 85);
  const height = Math.max(10, Math.round(halfWidth * aspectRatio * 0.5));

  function makeGrid(pts, startChar, endChar, trailChar) {
    const grid = Array.from({ length: height }, () => Array(halfWidth).fill(' '));
    function toCell(lng, lat) {
      const col = Math.floor((lng - minLng) / (maxLng - minLng) * (halfWidth - 1));
      const row = Math.floor((maxLat - lat) / (maxLat - minLat) * (height - 1));
      return [Math.max(0, Math.min(height - 1, row)), Math.max(0, Math.min(halfWidth - 1, col))];
    }
    const step = Math.max(1, Math.floor(pts.length / 300));
    for (let i = 0; i < pts.length; i += step) {
      const [r, c] = toCell(pts[i][0], pts[i][1]);
      if (grid[r][c] === ' ') grid[r][c] = trailChar;
    }
    const [sr, sc] = toCell(pts[0][0], pts[0][1]);
    const [er, ec] = toCell(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    grid[sr][sc] = startChar;
    grid[er][ec] = endChar;
    return grid;
  }

  const gridRef = routeB ? makeGrid(routeB, 's', 'e', 'o') : null;
  const gridGen = makeGrid(routeA, 'S', 'E', '*');

  const lines = [];
  const labelRef = '  Google reference';
  const labelGen = '  Generated';
  const padRef = ' '.repeat(Math.max(0, halfWidth + 2 - labelRef.length));
  lines.push(labelRef + padRef + '   ' + labelGen);

  const border = '+' + '-'.repeat(halfWidth) + '+';
  lines.push(border + '   ' + border);
  for (let r = 0; r < height; r++) {
    const left = gridRef ? '|' + gridRef[r].join('') + '|' : '|' + ' '.repeat(halfWidth) + '|';
    const right = '|' + gridGen[r].join('') + '|';
    lines.push(left + '   ' + right);
  }
  lines.push(border + '   ' + border);

  return lines.join('\n');
}

export { drawAscii, drawSideBySide };

// CLI
if (process.argv[1] && process.argv[1].endsWith('ascii-route.mjs')) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/lib/ascii-route.mjs <gpx-file> [reference-json]');
    process.exit(1);
  }

  const gpxFile = args[0];
  const routeA = parseGPX(readFileSync(gpxFile, 'utf8'));
  if (routeA.length === 0) {
    console.error('No trackpoints found in ' + gpxFile);
    process.exit(1);
  }

  let routeB = null;
  if (args[1]) {
    const refFile = args[1];
    const ext = refFile.split('.').pop();
    if (ext === 'json') {
      routeB = JSON.parse(readFileSync(refFile, 'utf8'));
    } else {
      routeB = parseGPX(readFileSync(refFile, 'utf8'));
    }
  }

  const w = parseInt(args[2] || '60');
  console.log(drawAscii(routeA, routeB, w));
}
