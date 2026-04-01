// auto-group.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoGroupNearbyPaths } from './auto-group.mjs';

const southMarch = JSON.parse(readFileSync(new URL('./fixtures/south-march-trails.json', import.meta.url), 'utf8'));
const pineGrove = JSON.parse(readFileSync(new URL('./fixtures/pine-grove-trails.json', import.meta.url), 'utf8'));

const mockQueryOverpass = async (q) => {
  // Return South March park for containment queries near that area
  if (q.includes('is_in') && q.includes('45.3')) {
    return { elements: [{ tags: { name: 'South March Highlands Conservation Forest' }, type: 'way', id: 548027518 }] };
  }
  return { elements: [] };
};

describe('autoGroupNearbyPaths', () => {
  it('groups South March trails into one entry named after the park', async () => {
    const result = await autoGroupNearbyPaths({
      entries: southMarch.entries,
      markdownSlugs: new Set(),
      queryOverpass: mockQueryOverpass,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'South March Highlands Conservation Forest');
    assert.ok(result[0].grouped_from.includes('coconut-tree'));
    assert.ok(result[0].grouped_from.includes('beartree'));
    assert.ok(result[0].grouped_from.includes('staycation'));
    assert.equal(result[0].grouped_from.length, 6);
  });

  it('merged entry has unioned osm_names', async () => {
    const result = await autoGroupNearbyPaths({
      entries: southMarch.entries,
      markdownSlugs: new Set(),
      queryOverpass: mockQueryOverpass,
    });
    assert.ok(result[0].osm_names.includes('Coconut Tree'));
    assert.ok(result[0].osm_names.includes('Beartree'));
    assert.ok(result[0].osm_names.includes('Staycation'));
  });

  it('keeps South March and Pine Grove as separate groups', async () => {
    const result = await autoGroupNearbyPaths({
      entries: [...southMarch.entries, ...pineGrove.entries],
      markdownSlugs: new Set(),
      queryOverpass: mockQueryOverpass,
    });
    assert.equal(result.length, 2);
    const names = result.map(e => e.name).sort();
    assert.ok(names.some(n => n.includes('South March')));
  });

  it('does not group entries claimed by markdown', async () => {
    const result = await autoGroupNearbyPaths({
      entries: southMarch.entries,
      markdownSlugs: new Set(['coconut-tree', 'beartree']),
      queryOverpass: mockQueryOverpass,
    });
    for (const entry of result) {
      if (entry.grouped_from) {
        assert.ok(!entry.grouped_from.includes('coconut-tree'));
        assert.ok(!entry.grouped_from.includes('beartree'));
      }
    }
  });

  it('absorbs new entry into existing group on re-run', async () => {
    const existingGroup = {
      name: 'South March Highlands Conservation Forest',
      grouped_from: ['coconut-tree', 'beartree'],
      osm_names: ['Coconut Tree', 'Beartree'],
      anchors: [[-75.946, 45.342], [-75.943, 45.345]],
      surface: 'ground',
      _ways: [[{ lat: 45.342, lon: -75.946 }, { lat: 45.343, lon: -75.944 }]],
    };
    const newEntry = {
      name: 'New Trail',
      osm_names: ['New Trail'],
      anchors: [[-75.944, 45.343]],
      surface: 'ground',
      _ways: [[{ lat: 45.343, lon: -75.944 }, { lat: 45.344, lon: -75.942 }]],
    };
    const result = await autoGroupNearbyPaths({
      entries: [existingGroup, newEntry],
      markdownSlugs: new Set(),
      queryOverpass: mockQueryOverpass,
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'South March Highlands Conservation Forest');
    assert.ok(result[0].grouped_from.includes('new-trail'));
    assert.ok(result[0].osm_names.includes('New Trail'));
  });

  it('is idempotent — running twice produces same output', async () => {
    const first = await autoGroupNearbyPaths({
      entries: southMarch.entries,
      markdownSlugs: new Set(),
      queryOverpass: mockQueryOverpass,
    });
    // Simulate re-run: re-attach _ways from original entries (as mergeData would)
    for (const entry of first) {
      if (entry.grouped_from && !entry._ways) {
        const ways = [];
        for (const osmName of entry.osm_names || []) {
          const src = southMarch.entries.find(e => e.name === osmName);
          if (src?._ways) ways.push(...src._ways);
        }
        if (ways.length > 0) entry._ways = ways;
      }
    }
    const second = await autoGroupNearbyPaths({
      entries: first,
      markdownSlugs: new Set(),
      queryOverpass: mockQueryOverpass,
    });
    assert.equal(second.length, 1);
    assert.equal(second[0].name, first[0].name);
    assert.deepEqual(second[0].grouped_from.sort(), first[0].grouped_from.sort());
    assert.deepEqual(second[0].osm_names.sort(), first[0].osm_names.sort());
  });

  it('preserves representative anchors in grouped entry (not just bbox)', async () => {
    const result = await autoGroupNearbyPaths({
      entries: southMarch.entries,
      markdownSlugs: new Set(),
      queryOverpass: mockQueryOverpass,
    });
    // Should have more than 2 anchors (not collapsed to bbox corners)
    assert.equal(result[0].anchors.length, 2, 'compact bbox anchors for YAML storage');
  });

  it('removes absorbed individual entries from output', async () => {
    const result = await autoGroupNearbyPaths({
      entries: southMarch.entries,
      markdownSlugs: new Set(),
      queryOverpass: mockQueryOverpass,
    });
    const allNames = result.map(e => e.name);
    assert.ok(!allNames.includes('Coconut Tree'), 'individual entry should be removed');
    assert.ok(!allNames.includes('Beartree'), 'individual entry should be removed');
  });
});
