// junction-ways.test.mjs
//
// Tests that non-cycling ways (bicycle:no) are included in _ways for
// clustering so trails connected through hiking junctions get grouped.
//
// Real case: Gatineau Park trails 54, 73, 74, 50.
// Trail 73 is entirely bicycle:no (hiking only) but it's the backbone
// connecting 54, 74, and 50 at junction nodes. Without Trail 73's
// geometry in _ways, the cycling trails can't find each other.
//
// The fix: _ways includes ALL ways for an entry's name (for connectivity),
// but only bikeable ways determine whether the entry gets a page.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { clusterByConnectivity } from './cluster-entries.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/gatineau-junction-trails.json', import.meta.url), 'utf8')
);

const trail54 = fixture.entries.find(e => e.name === 'Trail #54');
const trail73 = fixture.entries.find(e => e.name === 'Trail 73');
const trail74 = fixture.entries.find(e => e.name === 'Trail 74');
const trail50 = fixture.entries.find(e => e.name === 'Trail 50');

describe('junction ways — non-cycling ways for clustering', () => {
  // Baseline: with bike-only _ways, these trails DON'T connect
  it('trails 54, 74, 50 do NOT cluster with bike-only _ways', () => {
    const entries = [
      { ...trail54, _ways: trail54._ways_bike_only },
      { ...trail74, _ways: trail74._ways_bike_only },
      { ...trail50, _ways: trail50._ways_bike_only },
    ];
    const clusters = clusterByConnectivity(entries);
    // They should NOT form a single cluster — no shared nodes via bike-only ways
    const bigCluster = clusters.find(c => c.members.length === 3);
    expect(bigCluster).toBeUndefined();
  });

  // With ALL ways (including bicycle:no), Trail 73 provides junction nodes
  it('trails 54, 73, 74 cluster when _ways includes non-cycling ways', () => {
    // Trail 73 connects 54 and 74 through hiking-only junction nodes.
    // Trail 50 may not share nodes with this subgraph — test the core 3.
    const entries = [
      { ...trail54, _ways: trail54._ways_all, highway: 'cycleway', surface: 'ground' },
      { ...trail73, _ways: trail73._ways_all, highway: 'path', surface: 'ground' },
      { ...trail74, _ways: trail74._ways_all, highway: 'path', surface: 'ground' },
    ];
    const clusters = clusterByConnectivity(entries);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(3);
  });

  // Trail 73 (entirely bicycle:no) should be in the group but NOT get
  // its own page — it's a hiking trail that serves as a junction connector
  it('Trail 73 is not bikeable — 0 cycling ways', () => {
    expect(trail73.isBikeable).toBe(false);
    expect(trail73.bikeWayCount).toBe(0);
  });

  it('Trails 54, 74, 50 are bikeable', () => {
    expect(trail54.isBikeable).toBe(true);
    expect(trail74.isBikeable).toBe(true);
    expect(trail50.isBikeable).toBe(true);
  });

  // The grouped entry should exist, but Trail 73 should be excluded from
  // generating a standalone page (it's not cycling infrastructure).
  // The pipeline should: use ALL ways for clustering, but only create
  // page-worthy entries for trails with bikeable ways.
  it('clustering with all ways connects them, non-bikeable entries can be filtered after', () => {
    const entries = [
      { ...trail54, _ways: trail54._ways_all, _bikeable: true, highway: 'cycleway', surface: 'ground' },
      { ...trail73, _ways: trail73._ways_all, _bikeable: false, highway: 'path', surface: 'ground' },
      { ...trail74, _ways: trail74._ways_all, _bikeable: true, highway: 'path', surface: 'ground' },
    ];
    const clusters = clusterByConnectivity(entries);
    expect(clusters).toHaveLength(1);

    // After clustering, the group includes all 3, but only 2 are bikeable
    const bikeableMembers = clusters[0].members.filter(m => m._bikeable);
    const nonBikeableMembers = clusters[0].members.filter(m => !m._bikeable);
    expect(bikeableMembers).toHaveLength(2);
    expect(nonBikeableMembers).toHaveLength(1);
    expect(nonBikeableMembers[0].name).toBe('Trail 73');
  });
});
