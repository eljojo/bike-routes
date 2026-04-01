// cluster-entries.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clusterByConnectivity } from './cluster-entries.mjs';

const southMarch = JSON.parse(readFileSync(new URL('./fixtures/south-march-trails.json', import.meta.url), 'utf8'));
const pineGrove = JSON.parse(readFileSync(new URL('./fixtures/pine-grove-trails.json', import.meta.url), 'utf8'));

describe('clusterByConnectivity', () => {
  it('merges entries whose ways share a node', () => {
    const entries = [
      {
        name: 'Trail A', highway: 'path', surface: 'ground',
        anchors: [[-75.95, 45.34]],
        _ways: [[
          { lat: 45.340, lon: -75.950 },
          { lat: 45.341, lon: -75.949 },
          { lat: 45.342, lon: -75.948 },
        ]],
      },
      {
        name: 'Trail B', highway: 'path', surface: 'ground',
        anchors: [[-75.94, 45.35]],
        _ways: [[
          { lat: 45.342, lon: -75.948 },  // shared node with Trail A
          { lat: 45.343, lon: -75.947 },
          { lat: 45.344, lon: -75.946 },
        ]],
      },
    ];
    const clusters = clusterByConnectivity(entries);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 2);
  });

  it('does not merge entries with no shared nodes or nearby endpoints', () => {
    const entries = [
      {
        name: 'Trail A', highway: 'path', surface: 'ground',
        anchors: [[-75.95, 45.34]],
        _ways: [[
          { lat: 45.340, lon: -75.950 },
          { lat: 45.341, lon: -75.949 },
        ]],
      },
      {
        name: 'Trail B', highway: 'path', surface: 'ground',
        anchors: [[-75.90, 45.30]],
        _ways: [[
          { lat: 45.300, lon: -75.900 },
          { lat: 45.301, lon: -75.899 },
        ]],
      },
    ];
    const clusters = clusterByConnectivity(entries);
    assert.equal(clusters.length, 0);
  });

  it('merges entries whose endpoints are within 10m', () => {
    const entries = [
      {
        name: 'Trail A', highway: 'path', surface: 'ground',
        anchors: [[-75.95, 45.34]],
        _ways: [[
          { lat: 45.340, lon: -75.950 },
          { lat: 45.341, lon: -75.949 },
          { lat: 45.3420000, lon: -75.9480000 },
        ]],
      },
      {
        name: 'Trail B', highway: 'path', surface: 'ground',
        anchors: [[-75.94, 45.35]],
        _ways: [[
          { lat: 45.3420001, lon: -75.9479999 },  // ~0.1m from Trail A endpoint
          { lat: 45.343, lon: -75.947 },
          { lat: 45.344, lon: -75.946 },
        ]],
      },
    ];
    const clusters = clusterByConnectivity(entries);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 2);
  });

  it('excludes entries without _ways', () => {
    const entries = [
      {
        name: 'Trail A', highway: 'path', surface: 'ground',
        anchors: [[-75.95, 45.34]],
        _ways: [[
          { lat: 45.340, lon: -75.950 },
          { lat: 45.342, lon: -75.948 },
        ]],
      },
      {
        name: 'No Ways', highway: 'path', surface: 'ground',
        anchors: [[-75.95, 45.34]],
      },
    ];
    const clusters = clusterByConnectivity(entries);
    assert.equal(clusters.length, 0);
  });

  it('does not merge trail with paved cycleway', () => {
    const entries = [
      {
        name: 'Forest Trail', highway: 'path', surface: 'ground',
        anchors: [[-75.95, 45.34]],
        _ways: [[
          { lat: 45.340, lon: -75.950 },
          { lat: 45.342, lon: -75.948 },
        ]],
      },
      {
        name: 'City Cycleway', highway: 'cycleway', surface: 'asphalt',
        anchors: [[-75.94, 45.35]],
        _ways: [[
          { lat: 45.342, lon: -75.948 },  // shared node
          { lat: 45.343, lon: -75.947 },
        ]],
      },
    ];
    const clusters = clusterByConnectivity(entries);
    assert.equal(clusters.length, 0, 'trail and paved cycleway stay separate');
  });

  it('blocks merge across different operators', () => {
    const entries = [
      {
        name: 'Trail A', highway: 'path', surface: 'ground', operator: 'NCC',
        anchors: [[-75.95, 45.34]],
        _ways: [[{ lat: 45.340, lon: -75.950 }, { lat: 45.342, lon: -75.948 }]],
      },
      {
        name: 'Trail B', highway: 'path', surface: 'ground', operator: 'City of Ottawa',
        anchors: [[-75.94, 45.35]],
        _ways: [[{ lat: 45.342, lon: -75.948 }, { lat: 45.344, lon: -75.946 }]],
      },
    ];
    const clusters = clusterByConnectivity(entries);
    assert.equal(clusters.length, 0, 'different operators block merge');
  });

  it('blocks merge when corridor width exceeds 2km', () => {
    const entries = [
      {
        name: 'Trail A', highway: 'path', surface: 'ground',
        anchors: [[-75.96, 45.34], [-75.92, 45.34]],
        _ways: [[
          { lat: 45.340, lon: -75.960 },
          { lat: 45.340, lon: -75.940 },
          { lat: 45.342, lon: -75.920 },
        ]],
      },
      {
        name: 'Trail B', highway: 'path', surface: 'ground',
        anchors: [[-75.96, 45.38], [-75.92, 45.38]],
        _ways: [[
          { lat: 45.342, lon: -75.920 },
          { lat: 45.360, lon: -75.940 },
          { lat: 45.380, lon: -75.960 },
        ]],
      },
    ];
    const clusters = clusterByConnectivity(entries);
    assert.equal(clusters.length, 0, 'wide spread prevents merge');
  });

  it('chains transitive connections: A-B-C all merge', () => {
    const entries = [
      {
        name: 'Trail A', highway: 'path', surface: 'ground',
        anchors: [[-75.95, 45.34]],
        _ways: [[{ lat: 45.340, lon: -75.950 }, { lat: 45.342, lon: -75.948 }]],
      },
      {
        name: 'Trail B', highway: 'path', surface: 'ground',
        anchors: [[-75.94, 45.34]],
        _ways: [[{ lat: 45.342, lon: -75.948 }, { lat: 45.344, lon: -75.946 }]],
      },
      {
        name: 'Trail C', highway: 'path', surface: 'ground',
        anchors: [[-75.93, 45.34]],
        _ways: [[{ lat: 45.344, lon: -75.946 }, { lat: 45.346, lon: -75.944 }]],
      },
    ];
    const clusters = clusterByConnectivity(entries);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 3);
  });

  it('detects existing group and separates newMembers', () => {
    const existingGroup = {
      name: 'South March Highlands',
      grouped_from: ['coconut-tree', 'beartree'],
      anchors: [[-75.945, 45.342], [-75.943, 45.345]],
      _ways: [[{ lat: 45.342, lon: -75.945 }, { lat: 45.343, lon: -75.944 }]],
    };
    const newTrail = {
      name: 'New Trail', highway: 'path', surface: 'ground',
      anchors: [[-75.944, 45.343]],
      _ways: [[{ lat: 45.343, lon: -75.944 }, { lat: 45.344, lon: -75.943 }]],
    };
    const clusters = clusterByConnectivity([existingGroup, newTrail]);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].existingGroup.name, 'South March Highlands');
    assert.equal(clusters[0].newMembers.length, 1);
  });

  it('groups South March trails by way connectivity', () => {
    const clusters = clusterByConnectivity(southMarch.entries);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].members.length, 6);
  });

  it('keeps South March and Pine Grove separate (no shared nodes)', () => {
    const allEntries = [...southMarch.entries, ...pineGrove.entries];
    const clusters = clusterByConnectivity(allEntries);
    assert.equal(clusters.length, 2);
  });
});
