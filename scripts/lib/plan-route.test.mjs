import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { findCandidatePaths, planRoute } from './plan-route.mjs';
import { orderWays } from './order-ways.mjs';

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

describe('planRoute — real data integration', () => {
  it('two river places should select a river bike path', () => {
    const costanera = orderWays(JSON.parse(readFileSync(new URL('./fixtures/costanera-sur-ways.json', import.meta.url), 'utf8')));
    const mapocho42k = orderWays(JSON.parse(readFileSync(new URL('./fixtures/mapocho-42k-ways.json', import.meta.url), 'utf8')));
    const avMapocho = orderWays(JSON.parse(readFileSync(new URL('./fixtures/avenida-mapocho-ways.json', import.meta.url), 'utf8')));

    const allPaths = [
      { slug: 'costanera-sur', ways: costanera },
      { slug: 'mapocho-42k', ways: mapocho42k },
      { slug: 'avenida-mapocho', ways: avMapocho },
    ];

    // Two places along the river — should pick a river path
    const waypoints = [
      { type: 'place', coord: [-70.65, -33.42] },
      { type: 'place', coord: [-70.72, -33.42] },
    ];

    const result = planRoute(waypoints, allPaths);
    const insertedPaths = result.filter(r => Array.isArray(r));
    expect(insertedPaths.length).toBeGreaterThan(0);
  });

  it('places far from any bike path get no insertion', () => {
    const pocuro = orderWays(JSON.parse(readFileSync(new URL('./fixtures/pocuro-ways.json', import.meta.url), 'utf8')));
    const allPaths = [{ slug: 'pocuro', ways: pocuro }];

    // Two places in the far south, nowhere near pocuro
    const waypoints = [
      { type: 'place', coord: [-70.60, -33.60] },
      { type: 'place', coord: [-70.59, -33.61] },
    ];

    const result = planRoute(waypoints, allPaths);
    const insertedPaths = result.filter(r => Array.isArray(r));
    expect(insertedPaths.length).toBe(0);
  });
});
