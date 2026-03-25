import { describe, it, expect } from 'vitest';
import { detectAxes } from './axes.mjs';

/**
 * Build a synthetic segment along a line from [lng1,lat1] to [lng2,lat2].
 * Mimics the shape returned by parseOverpassWay().
 */
function makeSeg(index, name, normalizedName, lng1, lat1, lng2, lat2, opts = {}) {
  const coords = [[lng1, lat1], [lng2, lat2]];
  const cLng = (lng1 + lng2) / 2;
  const cLat = (lat1 + lat2) / 2;
  const dLng = lng2 - lng1;
  const dLat = lat2 - lat1;
  // Rough distance in metres (1 degree lat ≈ 111km, 1 degree lng ≈ 85km at -33°)
  const lengthM = Math.sqrt((dLat * 111000) ** 2 + (dLng * 85000) ** 2);

  return {
    index,
    source: 'test',
    nombre: name,
    normalizedName,
    comuna: opts.comuna || '',
    km: lengthM / 1000,
    geometry: { type: 'LineString', coordinates: coords },
    centroid: [cLng, cLat],
    start: [lng1, lat1],
    end: [lng2, lat2],
    lengthM,
    orientation: Math.abs(dLat) > Math.abs(dLng) ? 'ns' : 'ew',
    bearing: Math.abs(dLat) > Math.abs(dLng) ? 'north-south' : 'east-west',
    emplazamiento: opts.emplazamiento || null,
    score: opts.score ?? null,
    clasificacion: null,
    video: null,
    tipo: null,
    ancho_cm: null,
    surface: null,
    lit: null,
  };
}

describe('detectAxes', () => {
  describe('named axis preservation during geometric merge', () => {
    it('should not merge differently-named parallel axes', () => {
      // Reproduce the Mapocho 42K / Costanera Sur bug:
      // Two corridors run east-west along the same river, close together
      // but with different names. The smaller one should NOT be absorbed.

      // Costanera Sur: 5 segments, ~5km total, running east-west
      const costanera = [];
      for (let i = 0; i < 5; i++) {
        const lng1 = -70.70 + i * 0.01;
        const lng2 = lng1 + 0.01;
        costanera.push(makeSeg(i, 'Avenida Costanera Sur', 'COSTANERA SUR',
          lng1, -33.42, lng2, -33.42));
      }

      // Mapocho 42K: 4 segments, ~3.4km, running east-west ~200m south
      const mapocho = [];
      for (let i = 0; i < 4; i++) {
        const lng1 = -70.69 + i * 0.01;
        const lng2 = lng1 + 0.01;
        mapocho.push(makeSeg(5 + i, 'Mapocho 42k', 'MAPOCHO 42K',
          lng1, -33.422, lng2, -33.422));
      }

      const axes = detectAxes([...costanera, ...mapocho]);

      const costaneraAxes = axes.filter(a => a.segments.some(s => s.normalizedName === 'COSTANERA SUR'));
      const mapochoAxes = axes.filter(a => a.segments.some(s => s.normalizedName === 'MAPOCHO 42K'));

      // Both should exist as separate axes
      expect(costaneraAxes.length).toBeGreaterThanOrEqual(1);
      expect(mapochoAxes.length).toBeGreaterThanOrEqual(1);

      // No axis should contain segments from both names
      for (const ax of axes) {
        const names = new Set(ax.segments.map(s => s.normalizedName).filter(Boolean));
        expect(names.size).toBeLessThanOrEqual(1);
      }
    });

    it('should merge segments with the same name into one axis', () => {
      // 4 connected segments all named MAPOCHO 42K
      const segs = [];
      for (let i = 0; i < 4; i++) {
        const lng1 = -70.76 + i * 0.01;
        const lng2 = lng1 + 0.01;
        segs.push(makeSeg(i, 'Mapocho 42k', 'MAPOCHO 42K',
          lng1, -33.41, lng2, -33.41));
      }

      const axes = detectAxes(segs);
      const m42 = axes.filter(a => a.segments.some(s => s.normalizedName === 'MAPOCHO 42K'));

      // Should produce exactly 1 axis with all 4 segments
      expect(m42).toHaveLength(1);
      expect(m42[0].segments).toHaveLength(4);
    });

    it('should still merge unnamed small fragments into named axes', () => {
      // A named axis with a small unnamed fragment nearby
      const named = [
        makeSeg(0, 'Costanera Sur', 'COSTANERA SUR', -70.70, -33.42, -70.69, -33.42),
        makeSeg(1, 'Costanera Sur', 'COSTANERA SUR', -70.69, -33.42, -70.68, -33.42),
      ];
      // Unnamed fragment connecting at the end
      const unnamed = [
        makeSeg(2, '', '', -70.68, -33.42, -70.675, -33.42),
      ];

      const axes = detectAxes([...named, ...unnamed]);
      const cs = axes.filter(a => a.segments.some(s => s.normalizedName === 'COSTANERA SUR'));

      // The unnamed fragment should be absorbed into Costanera Sur
      expect(cs).toHaveLength(1);
      expect(cs[0].segments.length).toBeGreaterThanOrEqual(2);
    });
  });
});
