#!/usr/bin/env node

/**
 * Analyze Pedaleable's catastro GeoJSON and propose corridor groupings.
 *
 * Downloads the GeoJSON, finds segments whose endpoints are near each other,
 * and proposes corridors — connected chains of segments with measured gaps.
 *
 * Usage: node scripts/analyze-catastro.mjs [--threshold 500]
 *   --threshold  max gap in metres to consider segments "connectable" (default 500)
 */

const GEOJSON_URL =
  'https://raw.githubusercontent.com/pedaleable/mapa-catastro/refs/heads/gh-pages/datos/catastro.geojson';

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------

/** Haversine distance in metres between two [lng, lat] points. */
function haversineM([lng1, lat1], [lng2, lat2]) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Get the first and last coordinate of a MultiLineString geometry. */
function endpoints(geometry) {
  const coords = geometry.coordinates;
  const firstLine = coords[0];
  const lastLine = coords[coords.length - 1];
  return {
    start: firstLine[0].slice(0, 2),       // [lng, lat]
    end: lastLine[lastLine.length - 1].slice(0, 2),
  };
}

/** Total length of a MultiLineString in metres. */
function multiLineLength(geometry) {
  let total = 0;
  for (const line of geometry.coordinates) {
    for (let i = 1; i < line.length; i++) {
      total += haversineM(line[i - 1].slice(0, 2), line[i].slice(0, 2));
    }
  }
  return total;
}

/** Centre point of a MultiLineString (average of all coords). */
function centroid(geometry) {
  let sumLng = 0, sumLat = 0, n = 0;
  for (const line of geometry.coordinates) {
    for (const [lng, lat] of line) {
      sumLng += lng;
      sumLat += lat;
      n++;
    }
  }
  return [sumLng / n, sumLat / n];
}

// ---------------------------------------------------------------------------
// Segment model
// ---------------------------------------------------------------------------

function parseSegment(feature, index) {
  const p = feature.properties;
  const ep = endpoints(feature.geometry);
  return {
    index,
    nombre: p.nombre || `unnamed-${index}`,
    comuna: p._comuna || 'unknown',
    km: p.km || 0,
    computedLengthM: multiLineLength(feature.geometry),
    tipo: p._tipo || null,
    emplazamiento: p._emplazamiento || null,
    ancho_cm: p._ancho_cm || null,
    clasificacion: p._eval_graduada_pedal_clasif || null,
    score: p._eval_graduada_pedal || null,
    invalida: p['_inválida'] === '1',
    video: p.video || null,
    start: ep.start,
    end: ep.end,
    centroid: centroid(feature.geometry),
    geometry: feature.geometry,
  };
}

// ---------------------------------------------------------------------------
// Corridor building — find chains of nearby segments
// ---------------------------------------------------------------------------

/**
 * Find the minimum distance between any endpoint pair of two segments.
 * Returns { distance, fromEnd, toEnd } where fromEnd/toEnd are 'start'|'end'.
 */
function minEndpointDistance(a, b) {
  let best = { distance: Infinity, fromEnd: null, toEnd: null };
  for (const [aLabel, aCoord] of [['start', a.start], ['end', a.end]]) {
    for (const [bLabel, bCoord] of [['start', b.start], ['end', b.end]]) {
      const d = haversineM(aCoord, bCoord);
      if (d < best.distance) {
        best = { distance: d, fromEnd: aLabel, toEnd: bLabel };
      }
    }
  }
  return best;
}

/**
 * Build corridors by chaining segments whose endpoints are within threshold.
 * Uses union-find to group connected segments.
 */
function buildCorridors(segments, thresholdM) {
  const parent = segments.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };

  // Track edges (connections between segments) with gap distances
  const edges = [];

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const link = minEndpointDistance(segments[i], segments[j]);
      if (link.distance <= thresholdM) {
        union(i, j);
        edges.push({
          from: i,
          to: j,
          gapM: link.distance,
          fromEnd: link.fromEnd,
          toEnd: link.toEnd,
        });
      }
    }
  }

  // Group by root
  const groups = new Map();
  for (let i = 0; i < segments.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }

  // Build corridor objects
  const corridors = [];
  for (const [, memberIndices] of groups) {
    const members = memberIndices.map((i) => segments[i]);
    const corridorEdges = edges.filter(
      (e) => memberIndices.includes(e.from) && memberIndices.includes(e.to)
    );

    const infraLengthM = members.reduce((s, m) => s + m.computedLengthM, 0);
    const totalGapM = corridorEdges.reduce((s, e) => s + e.gapM, 0);
    const comunas = [...new Set(members.map((m) => m.comuna))].sort();

    // Worst condition in the corridor
    const conditionRank = { buena: 0, regular: 1, mala: 2, 'muy mala': 3 };
    const worstCondition = members
      .filter((m) => m.clasificacion)
      .sort((a, b) => (conditionRank[b.clasificacion] || 0) - (conditionRank[a.clasificacion] || 0))[0]
      ?.clasificacion || 'sin evaluar';

    corridors.push({
      segments: members,
      edges: corridorEdges,
      infraLengthM,
      totalGapM,
      totalLengthM: infraLengthM + totalGapM,
      comunas,
      worstCondition,
    });
  }

  // Sort by total length descending
  corridors.sort((a, b) => b.totalLengthM - a.totalLengthM);
  return corridors;
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

function corridorSlug(corridor) {
  if (corridor.segments.length === 1) {
    const s = corridor.segments[0];
    return slugify(`${s.nombre}-${s.comuna}`);
  }
  // Use the longest segment's name + comunas
  const longest = corridor.segments.sort((a, b) => b.computedLengthM - a.computedLengthM)[0];
  const comunaStr = corridor.comunas.length <= 2
    ? corridor.comunas.join('-')
    : corridor.comunas[0] + '-y-mas';
  return slugify(`${longest.nombre}-${comunaStr}`);
}

function slugify(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function formatDistance(metres) {
  return metres >= 1000
    ? `${(metres / 1000).toFixed(1)} km`
    : `${Math.round(metres)} m`;
}

function printCorridorReport(corridors) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`PROPOSED CORRIDOR GROUPINGS`);
  console.log(`${'='.repeat(70)}\n`);

  const totalSegments = corridors.reduce((s, c) => s + c.segments.length, 0);
  const soloCorridors = corridors.filter((c) => c.segments.length === 1);
  const multiCorridors = corridors.filter((c) => c.segments.length > 1);

  console.log(`Total segments: ${totalSegments}`);
  console.log(`Proposed corridors: ${corridors.length}`);
  console.log(`  Multi-segment corridors: ${multiCorridors.length}`);
  console.log(`  Standalone segments: ${soloCorridors.length}`);
  console.log();

  let corridorNum = 0;
  for (const corridor of corridors) {
    corridorNum++;
    const slug = corridorSlug(corridor);

    console.log(`${'-'.repeat(70)}`);
    console.log(`CORRIDOR ${corridorNum}: ${slug}`);
    console.log(`  Comunas: ${corridor.comunas.join(', ')}`);
    console.log(`  Segments: ${corridor.segments.length}`);
    console.log(`  Infrastructure: ${formatDistance(corridor.infraLengthM)}`);
    if (corridor.edges.length > 0) {
      console.log(`  Gaps: ${formatDistance(corridor.totalGapM)} across ${corridor.edges.length} gap(s)`);
      console.log(`  Total corridor: ${formatDistance(corridor.totalLengthM)} (${Math.round((corridor.infraLengthM / corridor.totalLengthM) * 100)}% protected)`);
    }
    console.log(`  Worst condition: ${corridor.worstCondition}`);
    console.log();

    for (const seg of corridor.segments.sort((a, b) => b.computedLengthM - a.computedLengthM)) {
      const parts = [
        formatDistance(seg.computedLengthM),
        seg.tipo || 'sin tipo',
        seg.emplazamiento ? `en ${seg.emplazamiento}` : '',
        seg.ancho_cm ? `${seg.ancho_cm}cm ancho` : '',
        seg.clasificacion || 'sin evaluar',
        seg.video ? 'video' : 'sin video',
      ].filter(Boolean);
      console.log(`    ${seg.nombre} (${seg.comuna}): ${parts.join(' | ')}`);
    }

    if (corridor.edges.length > 0) {
      console.log();
      console.log(`  Gaps:`);
      for (const edge of corridor.edges.sort((a, b) => b.gapM - a.gapM)) {
        const from = corridor.segments.find((s) => s.index === edge.from) ||
                     corridor.segments.find((_, i) => corridor.segments[i]?.index === edge.from);
        const to = corridor.segments.find((s) => s.index === edge.to) ||
                   corridor.segments.find((_, i) => corridor.segments[i]?.index === edge.to);
        const fromSeg = corridors.flatMap(c => c.segments).find(s => s.index === edge.from);
        const toSeg = corridors.flatMap(c => c.segments).find(s => s.index === edge.to);
        console.log(`    ${formatDistance(edge.gapM)} gap: ${fromSeg.nombre} (${edge.fromEnd}) → ${toSeg.nombre} (${edge.toEnd})`);
      }
    }
    console.log();
  }

  // Summary stats
  const totalInfraM = corridors.reduce((s, c) => s + c.infraLengthM, 0);
  const totalGapM = corridors.reduce((s, c) => s + c.totalGapM, 0);
  console.log(`${'='.repeat(70)}`);
  console.log(`SUMMARY`);
  console.log(`  Total infrastructure surveyed: ${formatDistance(totalInfraM)}`);
  console.log(`  Total gap distance (in corridors): ${formatDistance(totalGapM)}`);
  console.log(`  Corridors with gaps: ${multiCorridors.length}`);
  console.log(`  Isolated segments (no nearby connections): ${soloCorridors.length}`);
  console.log(`${'='.repeat(70)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const thresholdIdx = args.indexOf('--threshold');
  const thresholdM = thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : 500;

  console.log(`Fetching catastro GeoJSON...`);
  const res = await fetch(GEOJSON_URL);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
  const geojson = await res.json();

  console.log(`Parsing ${geojson.features.length} features...`);
  const segments = geojson.features.map((f, i) => parseSegment(f, i));

  console.log(`Building corridors (threshold: ${thresholdM}m)...`);
  const corridors = buildCorridors(segments, thresholdM);

  printCorridorReport(corridors);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
