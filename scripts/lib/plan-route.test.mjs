import { describe, it, expect } from 'vitest';
import { findCandidatePaths, planRoute } from './plan-route.mjs';

function makeWay(id, coords, tags = {}) {
  return { id, geometry: coords.map(([lon, lat]) => ({ lon, lat })), tags };
}

describe('findCandidatePaths', () => {
  it('finds a bike path within the corridor between two places', () => {
    const from = [-70.68, -33.42];
    const to = [-70.63, -33.42];
    const alameda = {
      slug: 'alameda',
      ways: [
        makeWay(1, [[-70.69, -33.421], [-70.66, -33.421]], { highway: 'cycleway' }),
        makeWay(2, [[-70.66, -33.421], [-70.62, -33.421]], { highway: 'cycleway' }),
      ],
    };
    const farPath = {
      slug: 'far-path',
      ways: [
        makeWay(3, [[-70.50, -33.50], [-70.49, -33.50]], { highway: 'cycleway' }),
      ],
    };
    const candidates = findCandidatePaths(from, to, [alameda, farPath]);
    expect(candidates.length).toBe(1);
    expect(candidates[0].slug).toBe('alameda');
  });

  it('returns empty when no paths are within corridor', () => {
    const from = [-70.68, -33.42];
    const to = [-70.63, -33.42];
    const farPath = {
      slug: 'far',
      ways: [makeWay(1, [[-70.50, -33.50], [-70.49, -33.50]], { highway: 'cycleway' })],
    };
    expect(findCandidatePaths(from, to, [farPath])).toHaveLength(0);
  });

  it('returns multiple candidates sorted by score (best first)', () => {
    const from = [-70.68, -33.42];
    const to = [-70.63, -33.42];
    const good = {
      slug: 'cycleway',
      ways: [makeWay(1, [[-70.68, -33.421], [-70.63, -33.421]], { highway: 'cycleway' })],
    };
    const ok = {
      slug: 'lane',
      ways: [makeWay(2, [[-70.68, -33.419], [-70.63, -33.419]], { highway: 'secondary', cycleway: 'lane' })],
    };
    const candidates = findCandidatePaths(from, to, [good, ok]);
    expect(candidates.length).toBe(2);
    expect(candidates[0].slug).toBe('cycleway');
  });
});

describe('planRoute', () => {
  const alameda = {
    slug: 'alameda',
    ways: [
      makeWay(1, [[-70.68, -33.421], [-70.65, -33.421]], { highway: 'cycleway' }),
      makeWay(2, [[-70.65, -33.421], [-70.63, -33.421]], { highway: 'cycleway' }),
    ],
  };
  const bello = {
    slug: 'andres-bello',
    ways: [
      makeWay(3, [[-70.63, -33.419], [-70.61, -33.419]], { highway: 'cycleway' }),
    ],
  };
  const allPaths = [alameda, bello];

  it('fills gap between two places with the best bike path', () => {
    const waypoints = [
      { type: 'place', coord: [-70.68, -33.42] },
      { type: 'place', coord: [-70.63, -33.42] },
    ];
    const result = planRoute(waypoints, allPaths);
    // Should insert alameda between the two places
    expect(result.length).toBe(3); // place + path + place
    expect(Array.isArray(result[1])).toBe(true); // the inserted path ways
  });

  it('does not fill gap when explicit bike path is present', () => {
    const waypoints = [
      { type: 'place', coord: [-70.68, -33.42] },
      { type: 'path', ways: alameda.ways },
      { type: 'place', coord: [-70.63, -33.42] },
    ];
    const result = planRoute(waypoints, allPaths);
    // No gap to fill — explicit path already there
    expect(result.length).toBe(3);
  });

  it('leaves gap as-is when no bike path is within corridor', () => {
    const waypoints = [
      { type: 'place', coord: [-70.50, -33.50] },
      { type: 'place', coord: [-70.49, -33.50] },
    ];
    const result = planRoute(waypoints, allPaths);
    // Two places, no path inserted
    expect(result.length).toBe(2);
  });

  it('fills multiple gaps in a multi-place route', () => {
    const waypoints = [
      { type: 'place', coord: [-70.68, -33.42] },
      { type: 'place', coord: [-70.63, -33.42] },
      { type: 'place', coord: [-70.61, -33.42] },
    ];
    const result = planRoute(waypoints, allPaths);
    const pathCount = result.filter(r => Array.isArray(r)).length;
    expect(pathCount).toBeGreaterThanOrEqual(1);
  });
});
