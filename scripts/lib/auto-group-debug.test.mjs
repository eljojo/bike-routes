// auto-group-debug.test.mjs
//
// Tests for auto-grouping producing networks v2:
// - Clusters become type: network entries with members arrays
// - Members KEEP their entries (no absorption)
// - Members get member_of pointing to their network
// - Park containment: same-name clusters merge into one network
// - Type-based corridor width limits

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { clusterByConnectivity, pathType } from './cluster-entries.mjs';
import { autoGroupNearbyPaths } from './auto-group.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/gatineau-trails-52-53.json', import.meta.url), 'utf8')
);
const [trail52, trail53] = fixture.entries;

describe('networks v2 — auto-groups become networks', () => {
  // Baseline: clustering still works
  it('clusterByConnectivity merges Trail 52 and 53 (shared node)', () => {
    const clusters = clusterByConnectivity([trail52, trail53]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(2);
  });

  // autoGroupNearbyPaths now produces network + members, not grouped_from
  it('autoGroupNearbyPaths creates network entry with members', async () => {
    const t52 = { ...trail52, highway: 'cycleway', surface: 'ground' };
    const t53 = { ...trail53, highway: 'cycleway', surface: 'ground' };

    const result = await autoGroupNearbyPaths({
      entries: [t52, t53],
      markdownSlugs: new Set(),
      queryOverpass: async () => ({ elements: [] }),
    });

    // Network entry exists
    const networks = result.filter(e => e.type === 'network');
    expect(networks).toHaveLength(1);
    expect(networks[0].members).toContain('trail-52');
    expect(networks[0].members).toContain('trail-53');

    // Members still in the array (not absorbed)
    const t52entry = result.find(e => e.name === 'Trail #52');
    const t53entry = result.find(e => e.name === 'Trail #53');
    expect(t52entry).toBeDefined();
    expect(t53entry).toBeDefined();

    // Members have member_of
    expect(t52entry.member_of).toBeDefined();
    expect(t53entry.member_of).toBeDefined();
    expect(t52entry.member_of).toBe(t53entry.member_of);
  });

  // No grouped_from in output
  it('no grouped_from in output — replaced by type: network + members', async () => {
    const t52 = { ...trail52, highway: 'cycleway', surface: 'ground' };
    const t53 = { ...trail53, highway: 'cycleway', surface: 'ground' };

    const result = await autoGroupNearbyPaths({
      entries: [t52, t53],
      markdownSlugs: new Set(),
      queryOverpass: async () => ({ elements: [] }),
    });

    for (const entry of result) {
      expect(entry.grouped_from).toBeUndefined();
    }
  });

  // Type-based corridor width
  it('trail corridor width of 5km allowed (20km limit for trails)', () => {
    const t52 = { ...trail52, highway: 'cycleway', surface: 'ground' };
    const t53 = { ...trail53, highway: 'cycleway', surface: 'ground' };
    const clusters = clusterByConnectivity([t52, t53]);
    expect(clusters).toHaveLength(1);
  });

  it('paved cycleways with >3km corridor width do not cluster', () => {
    const sharedNode = { lat: 45.42, lon: -75.70 };
    const a = {
      name: 'Cycleway A', highway: 'cycleway', surface: 'asphalt',
      anchors: [[-75.70, 45.42]],
      _ways: [
        [sharedNode, { lat: 45.45, lon: -75.70 }],
        [{ lat: 45.45, lon: -75.70 }, { lat: 45.45, lon: -75.66 }],
      ],
    };
    const b = {
      name: 'Cycleway B', highway: 'cycleway', surface: 'asphalt',
      anchors: [[-75.70, 45.39]],
      _ways: [
        [sharedNode, { lat: 45.39, lon: -75.70 }],
        [{ lat: 45.39, lon: -75.70 }, { lat: 45.39, lon: -75.74 }],
      ],
    };
    const clusters = clusterByConnectivity([a, b]);
    expect(clusters).toHaveLength(0);
  });

  it('paved cycleways within 3km cluster normally', () => {
    const sharedNode = { lat: 45.42, lon: -75.70 };
    const a = {
      name: 'Cycleway A', highway: 'cycleway', surface: 'asphalt',
      anchors: [[-75.70, 45.42]],
      _ways: [[sharedNode, { lat: 45.421, lon: -75.71 }]],
    };
    const b = {
      name: 'Cycleway B', highway: 'cycleway', surface: 'asphalt',
      anchors: [[-75.69, 45.42]],
      _ways: [[sharedNode, { lat: 45.419, lon: -75.69 }]],
    };
    const clusters = clusterByConnectivity([a, b]);
    expect(clusters).toHaveLength(1);
  });

  // mtb:scale heuristic
  it('cycleway with mtb:scale is classified as trail, not paved', () => {
    expect(pathType({ highway: 'cycleway' })).toBe('paved');
    expect(pathType({ highway: 'cycleway', 'mtb:scale': '1' })).toBe('trail');
  });
});
