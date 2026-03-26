import { describe, it, expect } from 'vitest';
import { resolveWaypoints } from './resolve-waypoints.mjs';

function makeWay(id, coords) {
  return { id, geometry: coords.map(([lon, lat]) => ({ lon, lat })) };
}

const mockFetchWays = async (slug) => {
  if (slug === 'pocuro') return [makeWay(1, [[-70.60, -33.43], [-70.59, -33.43]])];
  if (slug === 'costanera') return [makeWay(2, [[-70.65, -33.42], [-70.60, -33.42]])];
  return null;
};

describe('resolveWaypoints', () => {
  it('resolves bike path slugs to ways', async () => {
    const { chainWaypoints, resolved } = await resolveWaypoints(
      ['pocuro', 'costanera'],
      mockFetchWays,
    );
    expect(chainWaypoints).toHaveLength(2);
    expect(Array.isArray(chainWaypoints[0])).toBe(true); // ways array
    expect(Array.isArray(chainWaypoints[1])).toBe(true);
    expect(resolved).toEqual(['pocuro', 'costanera']);
  });

  it('passes place objects through unchanged', async () => {
    const place = { name: 'Canal San Carlos', lat: -33.433, lng: -70.5725 };
    const { chainWaypoints, resolved } = await resolveWaypoints(
      ['pocuro', place, 'costanera'],
      mockFetchWays,
    );
    expect(chainWaypoints).toHaveLength(3);
    expect(Array.isArray(chainWaypoints[0])).toBe(true);  // pocuro ways
    expect(chainWaypoints[1]).toEqual(place);               // place passed through
    expect(Array.isArray(chainWaypoints[2])).toBe(true);  // costanera ways
    expect(resolved).toEqual(['pocuro', 'Canal San Carlos', 'costanera']);
  });

  it('skips unknown slugs', async () => {
    const { chainWaypoints } = await resolveWaypoints(
      ['unknown-path', 'pocuro'],
      mockFetchWays,
    );
    expect(chainWaypoints).toHaveLength(1);
  });

  it('handles La Reina-style mixed waypoints', async () => {
    const csc = { name: 'Canal San Carlos', lat: -33.433, lng: -70.5725 };
    const san = { name: 'Sanhattan', lat: -33.418, lng: -70.605 };
    const { chainWaypoints, resolved } = await resolveWaypoints(
      ['pocuro', csc, 'costanera', san, 'pocuro'],
      mockFetchWays,
    );
    // 3 bike paths + 2 places = 5 waypoints
    expect(chainWaypoints).toHaveLength(5);
    expect(chainWaypoints[1]).toEqual(csc);
    expect(chainWaypoints[3]).toEqual(san);
    expect(resolved).toEqual(['pocuro', 'Canal San Carlos', 'costanera', 'Sanhattan', 'pocuro']);
  });
});
