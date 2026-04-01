// cluster-entries.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clusterEntries } from './cluster-entries.mjs';

const southMarch = JSON.parse(readFileSync(new URL('./fixtures/south-march-trails.json', import.meta.url), 'utf8'));
const pineGrove = JSON.parse(readFileSync(new URL('./fixtures/pine-grove-trails.json', import.meta.url), 'utf8'));

describe('clusterEntries', () => {
  it('groups all South March Highlands trails into one cluster', () => {
    const clusters = clusterEntries(southMarch.entries, 500);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 6);
    const names = clusters[0].members.map(m => m.name).sort();
    assert.deepEqual(names, ['Beartree', 'Coconut Tree', 'DeerDrop Baypass', 'North Dogsled', 'South Dogsled', 'Staycation']);
  });

  it('keeps South March and Pine Grove as separate clusters', () => {
    const allEntries = [...southMarch.entries, ...pineGrove.entries];
    const clusters = clusterEntries(allEntries, 500);
    assert.equal(clusters.length, 2);
  });

  it('does not create single-member clusters', () => {
    const clusters = clusterEntries([southMarch.entries[0]], 200);
    assert.equal(clusters.length, 0);
  });

  it('ignores entries without anchors', () => {
    const entries = [...southMarch.entries, { name: 'Ghost Trail' }];
    const clusters = clusterEntries(entries, 500);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 6);
  });

  it('splits clusters by operator', () => {
    const entries = [
      { name: 'A', anchors: [[-75.945, 45.342]], operator: 'NCC' },
      { name: 'B', anchors: [[-75.944, 45.343]], operator: 'City of Ottawa' },
    ];
    const clusters = clusterEntries(entries, 200);
    assert.equal(clusters.length, 0, 'different operators → no cluster (each would be single-member)');
  });

  it('allows grouping when one entry has no operator', () => {
    const entries = [
      { name: 'A', anchors: [[-75.945, 45.342]], operator: 'NCC' },
      { name: 'B', anchors: [[-75.944, 45.343]] },
    ];
    const clusters = clusterEntries(entries, 200);
    assert.equal(clusters.length, 1);
  });

  it('rejects union when bbox diagonal exceeds 5km', () => {
    const entries = [
      { name: 'A', anchors: [[-75.94, 45.34]] },
      { name: 'B', anchors: [[-75.94, 45.40]] },
    ];
    const clusters = clusterEntries(entries, 50000);
    assert.equal(clusters.length, 0, 'diameter cap prevents merge');
  });

  it('computes cluster bbox and centroid', () => {
    const clusters = clusterEntries(southMarch.entries, 500);
    const c = clusters[0];
    assert.ok(c.bbox.west < -75.95);
    assert.ok(c.bbox.east > -75.943);
    assert.ok(c.bbox.south < 45.336);
    assert.ok(c.bbox.north > 45.344);
    assert.ok(c.centroid.lat > 45.33 && c.centroid.lat < 45.35);
    assert.ok(c.centroid.lon > -75.96 && c.centroid.lon < -75.94);
  });

  it('absorbs new entry into existing grouped entry', () => {
    const existingGroup = {
      name: 'South March Highlands',
      grouped_from: ['coconut-tree', 'beartree'],
      anchors: [[-75.945, 45.342], [-75.943, 45.345]],
    };
    const newNearby = { name: 'New Trail', anchors: [[-75.944, 45.343]] };
    const clusters = clusterEntries([existingGroup, newNearby], 200);
    assert.equal(clusters.length, 1);
    assert.ok(clusters[0].existingGroup, 'cluster should reference the existing group');
    assert.equal(clusters[0].existingGroup.name, 'South March Highlands');
    assert.equal(clusters[0].newMembers.length, 1);
    assert.equal(clusters[0].newMembers[0].name, 'New Trail');
  });
});
