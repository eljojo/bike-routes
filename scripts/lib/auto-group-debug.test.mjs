// auto-group-debug.test.mjs
//
// Debugging why Trail #53 (Gatineau Park) doesn't cluster with Trail #52.
// They share exact node 45.631579,-75.943028 but end up in different groups.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { clusterByConnectivity, pathType } from './cluster-entries.mjs';
import { autoGroupNearbyPaths } from './auto-group.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/gatineau-trails-52-53.json', import.meta.url), 'utf8')
);
const [trail52, trail53] = fixture.entries;

describe('Gatineau Park Trail 53 clustering bug', () => {
  // Baseline: the raw clustering algorithm DOES connect them
  it('clusterByConnectivity merges Trail 52 and 53 (they share a node)', () => {
    const clusters = clusterByConnectivity([trail52, trail53]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(2);
  });

  // H1: Is trail-52 claimed by markdown, excluding it from candidates?
  // The markdown includes parc-de-la-gatineau-* groups, not trail-52 directly.
  // So trail-52 should NOT be excluded by the markdown filter.
  it('trail-52 is not directly claimed by markdown slugs', () => {
    // Read the actual markdown file
    const md = readFileSync(
      new URL('../../ottawa/bike-paths/sentier-du-parc-de-la-gatineau.md', import.meta.url),
      'utf8'
    );
    expect(md).not.toContain('trail-52');
    expect(md).not.toContain('trail-53');
    // But it DOES contain the group slugs
    expect(md).toContain('parc-de-la-gatineau-1');
  });

  // H2: When Trail 52 is absorbed into a grouped_from entry, does the
  // group preserve _ways so Trail 53 can still find the shared node?
  it('grouped_from entry that absorbed Trail 52 should preserve _ways for clustering', async () => {
    // Simulate what auto-grouping does: Trail 52 + Trail 57 cluster together.
    // The group replaces them. Then Trail 53 needs to connect to the group.
    const trail57 = {
      name: 'Trail 57',
      anchors: [[-75.96, 45.59]],
      highway: 'cycleway', surface: 'ground',
      // Trail 57 shares a node with Trail 52 (so they cluster)
      _ways: [[
        { lat: 45.582498, lon: -75.964203 },  // shared with trail 52
        { lat: 45.590, lon: -75.960 },
      ]],
    };

    // First round: cluster 52 + 57
    const round1 = clusterByConnectivity([trail52, trail57]);
    expect(round1).toHaveLength(1);

    // Now simulate the group entry that autoGroupNearbyPaths creates.
    // The key question: does it have _ways from BOTH absorbed members?
    // autoGroupNearbyPaths replaces members with a group entry.
    // The group entry gets merged tags and bbox anchors.
    // But does it get _ways?

    // Let's run autoGroupNearbyPaths and check
    const entries = [trail52, trail57, trail53];
    const result = await autoGroupNearbyPaths({
      entries,
      markdownSlugs: new Set(),
      queryOverpass: async () => ({ elements: [] }),
    });

    // Trail 53 should be in the same group as 52 and 57
    // because it shares a node with Trail 52
    const groups = result.filter(e => e.grouped_from);
    const standalone = result.filter(e => !e.grouped_from);

    // If Trail 53 is standalone, the bug is confirmed
    const trail53standalone = standalone.find(e => e.name === 'Trail #53');
    const groupWithAll = groups.find(g =>
      g.grouped_from?.includes('trail-53') ||
      g.grouped_from?.includes('trail-53')
    );

    // This is the assertion that reveals the bug:
    // Either Trail 53 is in a group, or it's standalone (bug)
    expect(
      trail53standalone === undefined || groupWithAll !== undefined,
      'Trail #53 should be grouped with Trail #52, not standalone'
    ).toBe(true);
  });

  // H2 deeper: autoGroupNearbyPaths builds group entries WITHOUT _ways.
  // Check if the group entry created from a cluster has _ways.
  it('autoGroupNearbyPaths group entries should carry _ways from members', async () => {
    const entries = [
      { ...trail52 },
      {
        name: 'Trail 57',
        anchors: [[-75.96, 45.59]],
        highway: 'cycleway', surface: 'ground',
        _ways: [[
          // Share a node with trail52 to force clustering
          trail52._ways[0][0],
          { lat: 45.590, lon: -75.960 },
        ]],
      },
    ];

    const result = await autoGroupNearbyPaths({
      entries,
      markdownSlugs: new Set(),
      queryOverpass: async () => ({ elements: [] }),
    });

    const group = result.find(e => e.grouped_from);
    expect(group).toBeDefined();

    // THE KEY QUESTION: does the group have _ways?
    // If not, that's the bug — Trail 53 can never connect to this group
    // because clusterByConnectivity requires _ways.
    expect(group._ways, 'group entry must carry _ways from absorbed members').toBeDefined();
    expect(group._ways.length).toBeGreaterThan(0);
  });

  // H5: Corridor width guard rejects the merge — 5136m > 2000m limit.
  // This is the root cause. Trail 52+53 endpoints span 5km (Gatineau Park is huge).
  // The fix: type-based corridor limits. Trails get 20km, paved 3km, roads 2km.
  it('corridor width of Trail 52 + 53 is ~5km (exceeds old 2km limit)', async () => {
    const { corridorWidth } = await import('./geo.mjs');
    const allEndpoints = [];
    for (const entry of [trail52, trail53]) {
      for (const way of entry._ways) {
        if (way.length >= 2) {
          allEndpoints.push([way[0].lon, way[0].lat]);
          allEndpoints.push([way[way.length - 1].lon, way[way.length - 1].lat]);
        }
      }
    }
    const width = corridorWidth(allEndpoints);
    // ~5136m — too wide for old 2km limit, fine for 20km trail limit
    expect(width).toBeGreaterThan(2000);
    expect(width).toBeLessThan(20000);
  });

  // After the fix: trails with type-based limit should cluster
  it('Trail 52 and 53 cluster when corridor limit is type-aware', () => {
    // Both are trails (highway: cycleway + surface: ground)
    const t52 = { ...trail52, highway: 'cycleway', surface: 'ground' };
    const t53 = { ...trail53, highway: 'cycleway', surface: 'ground' };
    const clusters = clusterByConnectivity([t52, t53]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(2);
  });

  // Paved cycleways whose combined corridor width exceeds 3km should NOT cluster.
  // corridorWidth measures the minimum perpendicular spread (thinnest axis).
  // Need 4 points forming a wide square so no rotation finds a thin axis.
  it('paved cycleways with >3km corridor width do not cluster', () => {
    const sharedNode = { lat: 45.42, lon: -75.70 };
    // A goes north, B goes east — forms an L that's wide in every rotation
    const a = {
      name: 'Cycleway A', highway: 'cycleway', surface: 'asphalt',
      anchors: [[-75.70, 45.42]],
      _ways: [
        [sharedNode, { lat: 45.45, lon: -75.70 }],  // 3.3km north
        [{ lat: 45.45, lon: -75.70 }, { lat: 45.45, lon: -75.66 }],  // then 3km east
      ],
    };
    const b = {
      name: 'Cycleway B', highway: 'cycleway', surface: 'asphalt',
      anchors: [[-75.70, 45.39]],
      _ways: [
        [sharedNode, { lat: 45.39, lon: -75.70 }],  // 3.3km south
        [{ lat: 45.39, lon: -75.70 }, { lat: 45.39, lon: -75.74 }],  // then 3km west
      ],
    };
    const clusters = clusterByConnectivity([a, b]);
    expect(clusters).toHaveLength(0);
  });

  // Paved cycleways within 3km should cluster
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

  // mtb:scale tag should override highway=cycleway → classify as trail
  // Trail 55 in Gatineau Park is tagged highway=cycleway but has mtb:scale=1,
  // meaning it's actually a dirt MTB trail. Without this heuristic, it gets
  // classified as 'paved' and can't cluster with neighboring 'trail' entries.
  it('cycleway with mtb:scale is classified as trail, not paved', () => {
    expect(pathType({ highway: 'cycleway' })).toBe('paved');
    expect(pathType({ highway: 'cycleway', 'mtb:scale': '1' })).toBe('trail');
    expect(pathType({ highway: 'cycleway', 'mtb:scale': '0' })).toBe('trail');
  });

  it('Trail 55 (cycleway + mtb:scale) clusters with Trail 74 (path + ground)', () => {
    const t55 = {
      name: 'Trail #55', highway: 'cycleway', 'mtb:scale': '1',
      anchors: [[-76.01, 45.61]],
      _ways: [[
        { lat: 45.61516, lon: -76.01367 },
        { lat: 45.60397, lon: -76.01307 },  // shared with Trail 74
      ]],
    };
    const t74 = {
      name: 'Trail 74', highway: 'path', surface: 'ground',
      anchors: [[-76.01, 45.60]],
      _ways: [[
        { lat: 45.60502, lon: -76.01307 },
        { lat: 45.60397, lon: -76.01307 },  // shared node
        { lat: 45.60397, lon: -76.00747 },
      ]],
    };
    // Both should be 'trail' type
    expect(pathType(t55)).toBe('trail');
    expect(pathType(t74)).toBe('trail');
    const clusters = clusterByConnectivity([t55, t74]);
    expect(clusters).toHaveLength(1);
  });

  // Full pipeline: Trail 53 should end up grouped after fix
  it('autoGroupNearbyPaths groups Trail 52 and 53 together', async () => {
    const t52 = { ...trail52, highway: 'cycleway', surface: 'ground' };
    const t53 = { ...trail53, highway: 'cycleway', surface: 'ground' };

    const result = await autoGroupNearbyPaths({
      entries: [t52, t53],
      markdownSlugs: new Set(),
      queryOverpass: async () => ({ elements: [] }),
    });

    const groups = result.filter(e => e.grouped_from);
    expect(groups).toHaveLength(1);
    expect(groups[0].grouped_from).toContain('trail-52');
    expect(groups[0].grouped_from).toContain('trail-53');
  });
});
