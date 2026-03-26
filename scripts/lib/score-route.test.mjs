import { describe, it, expect } from 'vitest';
import { relaxationScore } from './score-route.mjs';

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
