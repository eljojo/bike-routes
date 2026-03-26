import { describe, it, expect } from 'vitest';
import { relaxationScore, scoreRoute } from './score-route.mjs';

describe('relaxationScore', () => {
  it('highway=cycleway → 5 (full relaxation)', () => {
    expect(relaxationScore({ highway: 'cycleway' })).toBe(5);
  });

  it('cycleway=track → 5 (physically separated)', () => {
    expect(relaxationScore({ highway: 'secondary', cycleway: 'track' })).toBe(5);
  });

  it('cycleway=lane → 1 (painted line on road)', () => {
    expect(relaxationScore({ highway: 'secondary', cycleway: 'lane' })).toBe(1);
  });

  it('highway=path + bicycle=designated → 4', () => {
    expect(relaxationScore({ highway: 'path', bicycle: 'designated' })).toBe(4);
  });

  it('highway=residential + cycleway=lane → 2 (quiet street, lane)', () => {
    expect(relaxationScore({ highway: 'residential', cycleway: 'lane' })).toBe(2);
  });

  it('no cycling tags → 0 (tense)', () => {
    expect(relaxationScore({ highway: 'primary' })).toBe(0);
  });

  it('catastro emplazamiento parque overrides to 5', () => {
    expect(relaxationScore({ highway: 'cycleway' }, { emplazamiento: 'parque' })).toBe(5);
  });

  it('catastro emplazamiento calzada overrides to 0', () => {
    expect(relaxationScore({ highway: 'cycleway' }, { emplazamiento: 'calzada' })).toBe(0);
  });

  it('catastro emplazamiento mediana → 4', () => {
    expect(relaxationScore({ highway: 'cycleway' }, { emplazamiento: 'mediana' })).toBe(4);
  });

  it('catastro emplazamiento acera → 3', () => {
    expect(relaxationScore({ highway: 'cycleway' }, { emplazamiento: 'acera' })).toBe(3);
  });
});

function makeWay(id, coords, tags = {}) {
  return { id, geometry: coords.map(([lon, lat]) => ({ lon, lat })), tags };
}

describe('scoreRoute', () => {
  it('all-cycleway route scores high relaxation', () => {
    const ways = [
      makeWay(1, [[-70.60, -33.42], [-70.61, -33.42]], { highway: 'cycleway' }),
      makeWay(2, [[-70.61, -33.42], [-70.62, -33.42]], { highway: 'cycleway' }),
    ];
    const score = scoreRoute(ways, [-70.60, -33.42], [-70.62, -33.42]);
    expect(score.relaxation).toBeGreaterThan(8);
    expect(score.total).toBeGreaterThan(15);
  });

  it('mixed route scores lower relaxation than all-cycleway', () => {
    const ways = [
      makeWay(1, [[-70.60, -33.42], [-70.61, -33.42]], { highway: 'cycleway' }),
      makeWay(2, [[-70.61, -33.42], [-70.62, -33.42]], { highway: 'secondary', cycleway: 'lane' }),
    ];
    const score = scoreRoute(ways, [-70.60, -33.42], [-70.62, -33.42]);
    expect(score.relaxation).toBeLessThan(8);
  });

  it('very indirect route gets low directness', () => {
    const ways = [
      makeWay(1, [[-70.60, -33.42], [-70.55, -33.42]], { highway: 'cycleway' }),
      makeWay(2, [[-70.55, -33.42], [-70.60, -33.42]], { highway: 'cycleway' }),
    ];
    const score = scoreRoute(ways, [-70.60, -33.42], [-70.60, -33.42]);
    expect(score.directness).toBeLessThan(2);
  });

  it('transition penalty for relaxed→tense switch', () => {
    const ways = [
      makeWay(1, [[-70.60, -33.42], [-70.61, -33.42]], { highway: 'cycleway' }),
      makeWay(2, [[-70.61, -33.42], [-70.62, -33.42]], { highway: 'primary' }),
      makeWay(3, [[-70.62, -33.42], [-70.63, -33.42]], { highway: 'cycleway' }),
    ];
    const score = scoreRoute(ways, [-70.60, -33.42], [-70.63, -33.42]);
    expect(score.transitions).toBeLessThan(0);
  });
});
