import { describe, it, expect } from 'vitest';
import { deriveEntryType, waysLengthM } from './entry-type.mjs';

// Helper: make a simple straight-line _ways array of ~N metres
// 1 degree lat ≈ 111,320m, so 0.001° ≈ 111m
function makeWays(lengthDeg) {
  return [[
    { lat: 45.4, lon: -75.7 },
    { lat: 45.4 + lengthDeg, lon: -75.7 },
  ]];
}

describe('waysLengthM', () => {
  it('returns 0 for empty/missing _ways', () => {
    expect(waysLengthM(null)).toBe(0);
    expect(waysLengthM([])).toBe(0);
  });

  it('computes length for a simple straight line', () => {
    const ways = makeWays(0.01); // ~1.1km
    const len = waysLengthM(ways);
    expect(len).toBeGreaterThan(1000);
    expect(len).toBeLessThan(1200);
  });
});

describe('deriveEntryType', () => {
  it('skips network entries', () => {
    expect(deriveEntryType({ type: 'network' })).toBeUndefined();
  });

  // --- Destinations ---

  it('entries with osm_relations → destination', () => {
    expect(deriveEntryType({
      osm_relations: [12345], path_type: 'mup', _ways: makeWays(0.001),
    })).toBe('destination');
  });

  it('mtb-trail → destination regardless of length', () => {
    expect(deriveEntryType({
      path_type: 'mtb-trail', _ways: makeWays(0.001),
    })).toBe('destination');
  });

  it('long MUP → destination', () => {
    expect(deriveEntryType({
      path_type: 'mup', _ways: makeWays(0.02), osm_names: ['Some Path'],
    })).toBe('destination');
  });

  it('long trail → destination', () => {
    expect(deriveEntryType({
      path_type: 'trail', _ways: makeWays(0.015),
    })).toBe('destination');
  });

  // --- Infrastructure ---

  it('bike-lane on a real road → infrastructure', () => {
    expect(deriveEntryType({
      path_type: 'bike-lane', _ways: makeWays(0.005),
    })).toBe('infrastructure');
  });

  it('paved-shoulder → infrastructure', () => {
    expect(deriveEntryType({
      path_type: 'paved-shoulder', _ways: makeWays(0.005),
    })).toBe('infrastructure');
  });

  it('short named MUP → infrastructure', () => {
    expect(deriveEntryType({
      path_type: 'mup', _ways: makeWays(0.005), osm_names: ['Short Path'],
    })).toBe('infrastructure');
  });

  // --- Connectors ---

  it('tiny bike-lane → connector', () => {
    expect(deriveEntryType({
      path_type: 'bike-lane', _ways: makeWays(0.001),
    })).toBe('connector');
  });

  it('short unnamed MUP → connector', () => {
    expect(deriveEntryType({
      path_type: 'mup', _ways: makeWays(0.001),
    })).toBe('connector');
  });

  // --- Thresholds ---

  it('respects custom destination threshold', () => {
    // 500m MUP: connector at default 1000m, destination at custom 400m
    expect(deriveEntryType({
      path_type: 'mup', _ways: makeWays(0.005),
    })).not.toBe('destination');

    expect(deriveEntryType({
      path_type: 'mup', _ways: makeWays(0.005),
    }, { destinationLengthM: 400 })).toBe('destination');
  });

  // --- Real-world spot checks ---

  it('Sawmill Creek Pathway (relation) → destination', () => {
    expect(deriveEntryType({
      osm_relations: [7369960], path_type: 'mup', _ways: makeWays(0.02),
    })).toBe('destination');
  });

  it('Trilby Court (short bike-lane) → connector', () => {
    expect(deriveEntryType({
      path_type: 'bike-lane', _ways: makeWays(0.0005), // ~55m
    })).toBe('connector');
  });

  it('Bank Street (long bike-lane) → infrastructure', () => {
    expect(deriveEntryType({
      path_type: 'bike-lane', _ways: makeWays(0.03), // ~3.3km
    })).toBe('infrastructure');
  });
});
