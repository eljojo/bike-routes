import { describe, it, expect } from 'vitest';
import { derivePathType } from './path-type.mjs';

describe('derivePathType', () => {
  it('mtb=true → mtb-trail', () => {
    expect(derivePathType({ mtb: true, highway: 'path', surface: 'ground' })).toBe('mtb-trail');
  });

  it('mtb:scale >= 1 → mtb-trail (even without mtb boolean)', () => {
    expect(derivePathType({ 'mtb:scale': '2', highway: 'path', surface: 'dirt' })).toBe('mtb-trail');
  });

  it('mtb:scale 0 is NOT mtb-trail (scale 0 means any bike)', () => {
    expect(derivePathType({ 'mtb:scale': '0', highway: 'path', surface: 'dirt' })).toBe('trail');
  });

  it('parallel_to + cycleway=track → separated-lane', () => {
    expect(derivePathType({ parallel_to: 'Main St', cycleway: 'track' })).toBe('separated-lane');
  });

  it('parallel_to + cycleway=lane → bike-lane', () => {
    expect(derivePathType({ parallel_to: 'Main St', cycleway: 'lane' })).toBe('bike-lane');
  });

  it('parallel_to + cycleway=shoulder → paved-shoulder', () => {
    expect(derivePathType({ parallel_to: 'Main St', cycleway: 'shoulder' })).toBe('paved-shoulder');
  });

  it('parallel_to without cycleway → bike-lane (default for parallel)', () => {
    expect(derivePathType({ parallel_to: 'Main St' })).toBe('bike-lane');
  });

  it('unpaved surface without mtb → trail', () => {
    expect(derivePathType({ highway: 'path', surface: 'gravel' })).toBe('trail');
  });

  it('fine_gravel is unpaved → trail', () => {
    expect(derivePathType({ highway: 'cycleway', surface: 'fine_gravel' })).toBe('trail');
  });

  it('compacted is unpaved → trail', () => {
    expect(derivePathType({ highway: 'path', surface: 'compacted' })).toBe('trail');
  });

  it('asphalt cycleway → mup', () => {
    expect(derivePathType({ highway: 'cycleway', surface: 'asphalt' })).toBe('mup');
  });

  it('highway=path + bicycle=designated + paved → mup', () => {
    expect(derivePathType({ highway: 'path', bicycle: 'designated', surface: 'asphalt' })).toBe('mup');
  });

  it('no tags at all → mup (default)', () => {
    expect(derivePathType({})).toBe('mup');
  });

  it('mtb takes priority over parallel_to', () => {
    expect(derivePathType({ mtb: true, parallel_to: 'Main St', cycleway: 'track' })).toBe('mtb-trail');
  });

  it('parallel_to takes priority over unpaved surface', () => {
    expect(derivePathType({ parallel_to: 'Main St', surface: 'gravel' })).toBe('bike-lane');
  });

  it('network entries return undefined', () => {
    expect(derivePathType({ type: 'network', name: 'Capital Pathway' })).toBeUndefined();
  });
});
