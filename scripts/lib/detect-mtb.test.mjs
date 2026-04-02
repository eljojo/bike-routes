// detect-mtb.test.mjs
//
// MTB detection: label trails that aren't road-bike-friendly.
// Three tiers: explicit (mtb:scale tag), inferred (cluster has MTB),
// ambient (dirt path without cycling designation = probably MTB).

import { describe, it, expect } from 'vitest';
import { detectMtb } from './detect-mtb.mjs';

describe('detectMtb', () => {
  // Tier 1: explicit mtb:scale tag
  it('mtb:scale tag → mtb: true', () => {
    const entries = [
      { name: 'Trail 42', highway: 'path', surface: 'ground', 'mtb:scale': '3' },
    ];
    detectMtb(entries);
    expect(entries[0].mtb).toBe(true);
  });

  it('mtb:scale 0 → NOT mtb (means any bike, no difficulty)', () => {
    const entries = [
      { name: 'Trillium Pathway', highway: 'cycleway', surface: 'asphalt', 'mtb:scale': '0', bicycle: 'designated' },
    ];
    detectMtb(entries);
    expect(entries[0].mtb).toBeUndefined();
  });

  it('mtb:scale:imba tag → mtb: true', () => {
    const entries = [
      { name: 'Salamander', highway: 'path', 'mtb:scale:imba': '2' },
    ];
    detectMtb(entries);
    expect(entries[0].mtb).toBe(true);
  });

  // Tier 2: inferred from grouped_from cluster
  it('group with one explicit MTB member → all trail members get mtb: true', () => {
    const entries = [
      {
        name: 'Gatineau Trails',
        grouped_from: ['trail-41', 'trail-42', 'trail-43'],
        highway: 'path', surface: 'ground',
      },
      { name: 'Trail 41', highway: 'path', surface: 'ground' },
      { name: 'Trail 42', highway: 'path', surface: 'ground', 'mtb:scale': '3' },
      { name: 'Trail 43', highway: 'path', surface: 'ground' },
    ];
    detectMtb(entries);
    // The group and all its trail-type members should be MTB
    expect(entries[0].mtb).toBe(true); // group
    expect(entries[1].mtb).toBe(true); // trail-41 (inferred)
    expect(entries[2].mtb).toBe(true); // trail-42 (explicit)
    expect(entries[3].mtb).toBe(true); // trail-43 (inferred)
  });

  it('group with MTB member does NOT infect paved members', () => {
    const entries = [
      {
        name: 'Mixed Group',
        grouped_from: ['paved-connector', 'dirt-trail'],
        highway: 'cycleway', surface: 'asphalt',
      },
      { name: 'Paved Connector', highway: 'cycleway', surface: 'asphalt' },
      { name: 'Dirt Trail', highway: 'path', surface: 'ground', 'mtb:scale': '1' },
    ];
    detectMtb(entries);
    expect(entries[1].mtb).toBeUndefined(); // paved stays paved
    expect(entries[2].mtb).toBe(true);      // dirt trail is MTB
  });

  // Tier 3: ambient — dirt path without cycling designation
  it('highway=path + ground surface + no bicycle tag → mtb: true', () => {
    const entries = [
      { name: 'Trail 41', highway: 'path', surface: 'ground' },
    ];
    detectMtb(entries);
    expect(entries[0].mtb).toBe(true);
  });

  it('highway=path + no surface + no bicycle tag → mtb: true', () => {
    const entries = [
      { name: 'Mystery Trail', highway: 'path' },
    ];
    detectMtb(entries);
    expect(entries[0].mtb).toBe(true);
  });

  // Should NOT be MTB
  it('highway=path + bicycle=designated → NOT mtb (proper cycling infra)', () => {
    const entries = [
      { name: 'NCC Pathway', highway: 'path', surface: 'asphalt', bicycle: 'designated' },
    ];
    detectMtb(entries);
    expect(entries[0].mtb).toBeUndefined();
  });

  it('highway=cycleway + asphalt → NOT mtb', () => {
    const entries = [
      { name: 'Laurier Bikelane', highway: 'cycleway', surface: 'asphalt' },
    ];
    detectMtb(entries);
    expect(entries[0].mtb).toBeUndefined();
  });

  it('highway=cycleway + ground → mtb (paved tag but dirt surface)', () => {
    const entries = [
      { name: 'Trail 55', highway: 'cycleway', surface: 'ground' },
    ];
    detectMtb(entries);
    expect(entries[0].mtb).toBe(true);
  });

  it('parallel_to road entries → never mtb', () => {
    const entries = [
      { name: 'Bank Street', highway: 'cycleway', parallel_to: 'Bank Street' },
    ];
    detectMtb(entries);
    expect(entries[0].mtb).toBeUndefined();
  });
});
