import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { filterCyclingWays } from './filter-cycling-ways.mjs';
import { orderWays } from './order-ways.mjs';
import { haversineM } from './geo.mjs';

function renderTrace(ways) {
  const pts = [];
  let prev = null;
  for (const w of ways) {
    const coords = w.geometry.map(p => [p.lon, p.lat]);
    let trace = w._reversed ? [...coords].reverse() : coords;
    if (prev && w._reversed == null) {
      if (haversineM(prev, trace[trace.length - 1]) < haversineM(prev, trace[0]))
        trace = [...trace].reverse();
    }
    for (const c of trace) pts.push(c);
    prev = trace[trace.length - 1];
  }
  return pts;
}

function countReversals(pts) {
  let revs = 0, lastB = null, prev = null;
  for (const p of pts) {
    if (prev) {
      if (haversineM(prev, p) < 1) { prev = p; continue; }
      const b = Math.atan2(p[0] - prev[0], p[1] - prev[1]);
      if (lastB !== null) {
        let df = Math.abs(b - lastB); if (df > Math.PI) df = 2 * Math.PI - df;
        if (df > 2 * Math.PI / 3) revs++;
      }
      lastB = b;
    }
    prev = p;
  }
  return revs;
}

function totalDistance(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversineM(pts[i - 1], pts[i]);
  return d;
}

describe('filterCyclingWays', () => {
  // Pedro Aguirre Cerda: OSM relation has 90 ways —
  //   5 cycleways (the actual bike path, 4.6km)
  //   71 primary oneway roads (parallel car lanes, both directions)
  //   9 tertiary roads (disconnected segments 10km away)
  //   5 residential roads
  //
  // Without filtering: orderWays produces 28 ways, 34.8km, 14 reversals
  // (zigzags between parallel lanes).
  // With filtering: should keep only the 5 cycleways → 4.6km, 0 reversals.

  it('prefers cycleways over parallel road lanes (Pedro Aguirre Cerda)', () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/pedro-aguirre-cerda-ways.json', import.meta.url), 'utf8'));
    const filtered = filterCyclingWays(raw);
    const ordered = orderWays(filtered);
    const pts = renderTrace(ordered);
    const dist = totalDistance(pts);
    const revs = countReversals(pts);

    // Should keep cycleways + roads with bike tags + parks, not plain parallel lanes
    for (const w of filtered) {
      const t = w.tags || {};
      const isRideable = t.highway === 'cycleway' || t.cycleway || t['cycleway:left'] ||
        t['cycleway:right'] || t['cycleway:both'] || t.bicycle === 'designated' || t.bicycle === 'yes' ||
        t.leisure === 'park' || t.highway === 'path' || t.highway === 'pedestrian';
      expect(!!isRideable, 'way ' + w.id + ' (' + (t.highway || t.leisure || 'no tags') + ') is not rideable').toBe(true);
    }

    // Route should be short (cycling infra only), not 34.8km (all parallel lanes)
    expect(dist, 'distance ' + (dist/1000).toFixed(1) + 'km').toBeLessThan(10000);

    // No reversals from zigzagging between parallel lanes
    expect(revs, revs + ' reversals').toBe(0);
  });

  it('falls back to roads with bike lanes when no cycleways exist', () => {
    const ways = [
      { id: 1, geometry: [{lon: -70.6, lat: -33.4}, {lon: -70.61, lat: -33.41}], tags: { highway: 'primary', cycleway: 'lane' } },
      { id: 2, geometry: [{lon: -70.61, lat: -33.41}, {lon: -70.62, lat: -33.42}], tags: { highway: 'primary', cycleway: 'lane' } },
      { id: 3, geometry: [{lon: -70.62, lat: -33.42}, {lon: -70.63, lat: -33.43}], tags: { highway: 'primary' } },
    ];
    const filtered = filterCyclingWays(ways);
    // Should keep the two with cycleway=lane, not the plain road
    expect(filtered.length).toBe(2);
    expect(filtered.every(w => w.tags.cycleway === 'lane')).toBe(true);
  });

  it('falls back to roads when no cycling infrastructure at all', () => {
    const ways = [
      { id: 1, geometry: [{lon: -70.6, lat: -33.4}, {lon: -70.61, lat: -33.41}], tags: { highway: 'tertiary' } },
      { id: 2, geometry: [{lon: -70.61, lat: -33.41}, {lon: -70.62, lat: -33.42}], tags: { highway: 'primary' } },
    ];
    const filtered = filterCyclingWays(ways);
    expect(filtered.length).toBe(2);
  });

  it('drops non-cycling ways when cycleways exist', () => {
    const ways = [
      { id: 1, geometry: [{lon: -70.6, lat: -33.4}, {lon: -70.61, lat: -33.41}], tags: { highway: 'cycleway' } },
      { id: 2, geometry: [{lon: -70.6, lat: -33.4}, {lon: -70.61, lat: -33.41}], tags: { highway: 'primary', oneway: 'yes' } },
      { id: 3, geometry: [{lon: -70.61, lat: -33.41}, {lon: -70.6, lat: -33.4}], tags: { highway: 'primary', oneway: 'yes' } },
    ];
    const filtered = filterCyclingWays(ways);
    expect(filtered.length).toBe(1);
    expect(filtered[0].tags.highway).toBe('cycleway');
  });
});
