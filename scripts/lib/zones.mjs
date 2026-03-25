/**
 * Zone detection — sensory corridors, vibe neighborhoods, repulsion zones.
 *
 * Detects continuous areas of interest from Overpass data. Each zone is
 * represented as a set of 200m grid cells — no complex polygon geometry.
 *
 * All coordinates are [lng, lat] (GeoJSON order).
 */

import { haversineM, polygonToGridCells } from './geo.mjs';

// 0.002° ≈ 200m — the universal zone cell grid
const ZONE_GRID = 0.002;

// 0.005° ≈ 500m — coarser grid for vibe clustering
const VIBE_GRID = 0.005;

/** Grid cell key for a [lng, lat] coordinate at the given resolution. */
function cellKey(coord, resolution = ZONE_GRID) {
  return `${Math.floor(coord[0] / resolution)},${Math.floor(coord[1] / resolution)}`;
}

// ---------------------------------------------------------------------------
// Grid buffering
// ---------------------------------------------------------------------------

/**
 * All zone-grid cell keys within radiusM of a single [lng, lat] point.
 * @param {[number, number]} coord
 * @param {number} radiusM
 * @returns {Set<string>}
 */
export function bufferPointToGrid(coord, radiusM) {
  const cells = new Set();
  // Convert radius to approximate degree offset
  const latDeg = radiusM / 111_320;
  const lngDeg = radiusM / (111_320 * Math.cos((coord[1] * Math.PI) / 180));
  const steps = Math.ceil(Math.max(latDeg, lngDeg) / ZONE_GRID) + 1;

  for (let dx = -steps; dx <= steps; dx++) {
    for (let dy = -steps; dy <= steps; dy++) {
      const candidate = [
        coord[0] + dx * ZONE_GRID,
        coord[1] + dy * ZONE_GRID,
      ];
      if (haversineM(coord, candidate) <= radiusM) {
        cells.add(cellKey(candidate));
      }
    }
  }
  return cells;
}

/**
 * All zone-grid cell keys within radiusM of a polyline.
 * @param {Array<[number, number]>} coords - array of [lng, lat]
 * @param {number} radiusM
 * @returns {Set<string>}
 */
export function bufferLineToGrid(coords, radiusM) {
  const cells = new Set();
  for (const pt of coords) {
    for (const c of bufferPointToGrid(pt, radiusM)) {
      cells.add(c);
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------
// Centre of a cell set
// ---------------------------------------------------------------------------

/** Average coordinate of a set of grid cell keys. */
function cellSetCenter(cells) {
  let sumLng = 0;
  let sumLat = 0;
  let count = 0;
  for (const key of cells) {
    const [gx, gy] = key.split(',').map(Number);
    sumLng += (gx + 0.5) * ZONE_GRID;
    sumLat += (gy + 0.5) * ZONE_GRID;
    count++;
  }
  return [sumLng / count, sumLat / count];
}

// ---------------------------------------------------------------------------
// Sensory zones — rivers, canals, large parks
// ---------------------------------------------------------------------------

/**
 * Detect sensory corridor zones from waterways and park POIs.
 *
 * Each named waterway becomes one zone (buffered 150m, magnetism 9).
 * Park POIs with anchorScore >= 7 become zones (buffered 300m, magnetism 8).
 *
 * @param {Array<{ name: string, geometry: Array<[number, number]> }>} waterways
 * @param {Array<{ name: string, lat: number, lng: number, extent?: number, geometry?: Array<[number, number]> }>} parkAreas
 * @returns {Array} zones
 */
export function detectSensoryZones(waterways, parkAreas) {
  const zones = [];

  // Group waterway segments by name so the same river is one zone
  const byName = new Map();
  for (const ww of waterways) {
    if (!ww.name) continue;
    if (!byName.has(ww.name)) byName.set(ww.name, []);
    byName.get(ww.name).push(ww.geometry);
  }

  for (const [name, segments] of byName) {
    const cells = new Set();
    for (const geom of segments) {
      for (const c of bufferLineToGrid(geom, 150)) cells.add(c);
    }
    if (cells.size === 0) continue;

    zones.push({
      name,
      type: 'sensory',
      magnetism: 9,
      centerCoord: cellSetCenter(cells),
      cells,
    });
  }

  // Parks with polygon geometry → area zones
  for (const park of parkAreas) {
    if (park.extent < 500) continue; // only significant parks become zones

    let cells;
    if (park.geometry && park.geometry.length >= 3) {
      cells = polygonToGridCells(park.geometry);
    } else {
      // Fallback: buffer center point
      cells = bufferPointToGrid([park.lng, park.lat], 300);
    }
    if (cells.size === 0) continue;

    const magnetism = park.extent > 1000 ? 9 : park.extent > 500 ? 8 : 7;
    zones.push({
      name: park.name,
      type: 'park',
      magnetism,
      centerCoord: [park.lng, park.lat],
      cells,
    });
  }

  return zones;
}

// ---------------------------------------------------------------------------
// Vibe neighborhoods — dense clusters of interesting POIs
// ---------------------------------------------------------------------------

/**
 * Detect vibe neighborhood zones from POI clustering.
 *
 * POIs are gridded on a 500m grid. Cells with >15 POIs are "dense".
 * Adjacent dense cells are flood-filled into one zone.
 *
 * @param {Array<{ lat: number, lng: number, tags: object }>} pois
 * @returns {Array} zones
 */
export function detectVibeZones(pois) {
  // Count POIs per coarse cell
  const cellCounts = new Map();  // coarse key → count
  const cellTags = new Map();    // coarse key → tag value counts

  for (const poi of pois) {
    const key = cellKey([poi.lng, poi.lat], VIBE_GRID);
    cellCounts.set(key, (cellCounts.get(key) ?? 0) + 1);

    // Track tag values for naming
    if (!cellTags.has(key)) cellTags.set(key, new Map());
    const tagMap = cellTags.get(key);
    for (const val of Object.values(poi.tags)) {
      if (typeof val === 'string' && val.length > 1) {
        tagMap.set(val, (tagMap.get(val) ?? 0) + 1);
      }
    }
  }

  // Find dense cells (>15 POIs)
  const denseCells = new Set();
  for (const [key, count] of cellCounts) {
    if (count > 15) denseCells.add(key);
  }

  // Flood fill adjacent dense cells into clusters
  const visited = new Set();
  const clusters = [];

  for (const key of denseCells) {
    if (visited.has(key)) continue;
    const cluster = new Set();
    const queue = [key];

    while (queue.length > 0) {
      const current = queue.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      cluster.add(current);

      // Check 8-connected neighbors on the coarse grid
      const [gx, gy] = current.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const neighbor = `${gx + dx},${gy + dy}`;
          if (denseCells.has(neighbor) && !visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }
    }

    clusters.push(cluster);
  }

  // Convert clusters to zones
  const zones = [];

  for (const cluster of clusters) {
    // Convert coarse 500m cells to fine 200m zone cells
    const zoneCells = new Set();
    const ratio = VIBE_GRID / ZONE_GRID; // 2.5

    for (const key of cluster) {
      const [gx, gy] = key.split(',').map(Number);
      const baseLng = gx * VIBE_GRID;
      const baseLat = gy * VIBE_GRID;

      // Fill in the fine cells that this coarse cell covers
      for (let dx = 0; dx < ratio; dx++) {
        for (let dy = 0; dy < ratio; dy++) {
          const fineLng = baseLng + dx * ZONE_GRID;
          const fineLat = baseLat + dy * ZONE_GRID;
          zoneCells.add(cellKey([fineLng, fineLat]));
        }
      }
    }

    // Count total POIs in this cluster
    let totalPOIs = 0;
    const mergedTags = new Map();
    for (const key of cluster) {
      totalPOIs += cellCounts.get(key) ?? 0;
      const tags = cellTags.get(key);
      if (tags) {
        for (const [val, count] of tags) {
          mergedTags.set(val, (mergedTags.get(val) ?? 0) + count);
        }
      }
    }

    // Name: most common tag value, or positional fallback
    let name;
    if (mergedTags.size > 0) {
      let bestVal = null;
      let bestCount = 0;
      for (const [val, count] of mergedTags) {
        if (count > bestCount) {
          bestVal = val;
          bestCount = count;
        }
      }
      name = `Barrio ${bestVal}`;
    } else {
      const [firstKey] = cluster;
      name = `Barrio ${firstKey}`;
    }

    const magnetism = 6 + Math.min(totalPOIs / 30, 2);

    zones.push({
      name,
      type: 'vibe',
      magnetism,
      centerCoord: cellSetCenter(zoneCells),
      cells: zoneCells,
    });
  }

  return zones;
}

// ---------------------------------------------------------------------------
// Repulsion zones — highways and motorways
// ---------------------------------------------------------------------------

/**
 * Detect repulsion zones from motorway geometries.
 *
 * @param {Array<Array<[number, number]>>} motorways - coordinate arrays
 * @returns {Array} zones
 */
export function detectRepulsionZones(motorways) {
  if (!motorways || motorways.length === 0) return [];

  // Buffer all motorways and merge into one big repulsion set,
  // then split into connected components for individual zones
  const allCells = new Set();
  for (const coords of motorways) {
    for (const c of bufferLineToGrid(coords, 150)) {
      allCells.add(c);
    }
  }

  if (allCells.size === 0) return [];

  // Flood fill to find connected components
  const visited = new Set();
  const zones = [];

  for (const key of allCells) {
    if (visited.has(key)) continue;
    const component = new Set();
    const queue = [key];

    while (queue.length > 0) {
      const current = queue.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      component.add(current);

      const [gx, gy] = current.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const neighbor = `${gx + dx},${gy + dy}`;
          if (allCells.has(neighbor) && !visited.has(neighbor)) {
            queue.push(neighbor);
          }
        }
      }
    }

    zones.push({
      name: `Autopista ${zones.length + 1}`,
      type: 'repulsion',
      magnetism: -8,
      centerCoord: cellSetCenter(component),
      cells: component,
    });
  }

  return zones;
}

// ---------------------------------------------------------------------------
// Accessibility boosters
// ---------------------------------------------------------------------------

/**
 * Modify zone magnetism based on nearby transit and bike infrastructure.
 *
 * Metro station within 500m of zone center → magnetism += 1
 * Bike parking within 300m of zone center → magnetism += 0.5
 *
 * @param {Array} zones - mutated in place
 * @param {Array<{ lat: number, lng: number }>} metroStations
 * @param {Array<{ lat: number, lng: number }>} bikeParking
 */
export function applyAccessibilityBoosters(zones, metroStations, bikeParking) {
  if (!metroStations && !bikeParking) return;

  for (const zone of zones) {
    if (zone.type === 'repulsion') continue;

    let hasMetro = false;
    let hasBikeParking = false;

    if (metroStations) {
      for (const station of metroStations) {
        if (haversineM(zone.centerCoord, [station.lng, station.lat]) <= 500) {
          hasMetro = true;
          break;
        }
      }
    }

    if (bikeParking) {
      for (const bp of bikeParking) {
        if (haversineM(zone.centerCoord, [bp.lng, bp.lat]) <= 300) {
          hasBikeParking = true;
          break;
        }
      }
    }

    if (hasMetro) zone.magnetism += 1;
    if (hasBikeParking) zone.magnetism += 0.5;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Detect all zones from Overpass data.
 *
 * @param {object} data
 * @param {Array} data.waterways - from fetchWaterways()
 * @param {Array} data.pois - from fetchZonePOIs() (for vibe clustering)
 * @param {Array} data.motorways - from fetchMotorways()
 * @param {Array} data.metroStations - from fetchMetroStations()
 * @param {Array} data.bikeParking - from fetchBikeParking()
 * @param {Array} [data.treeRows] - from fetchTreeRows()
 * @param {Array} [data.parkAreas] - park areas with polygon geometry from fetchParkAreas()
 * @returns {{ zones: Array, repulsionCells: Set<string>, treeCells: Set<string> }}
 */
export function detectZones({ waterways, pois, motorways, metroStations, bikeParking, treeRows, parkAreas }) {
  const sensory = detectSensoryZones(waterways, parkAreas || []);
  const vibe = detectVibeZones(pois);
  const repulsion = detectRepulsionZones(motorways);

  let zones = [...sensory, ...vibe];
  applyAccessibilityBoosters(zones, metroStations, bikeParking);

  // Cap total zones to keep the zone graph build tractable.
  // 186 zones = 17k A* pairs = 20+ minutes. 80 zones = 3k pairs = ~30 seconds.
  const MAX_ZONES = 80;
  if (zones.length > MAX_ZONES) {
    zones.sort((a, b) => b.magnetism - a.magnetism || b.cells.size - a.cells.size);
    const dropped = zones.length - MAX_ZONES;
    zones = zones.slice(0, MAX_ZONES);
    console.log(`[zones] Capped to ${MAX_ZONES} zones (dropped ${dropped} lowest-magnetism)`);
  }

  const repulsionCells = new Set();
  for (const rz of repulsion) for (const cell of rz.cells) repulsionCells.add(cell);

  const treeCells = new Set();
  if (treeRows) {
    for (const row of treeRows) {
      for (const cell of bufferLineToGrid(row, 30)) treeCells.add(cell);
    }
  }

  console.log(`[zones] ${sensory.length} sensory + ${vibe.length} vibe → ${zones.length} zones (after cap)`);
  console.log(`[zones] ${repulsion.length} repulsion zones, ${treeCells.size} tree cells`);

  return { zones, repulsionCells, treeCells };
}
