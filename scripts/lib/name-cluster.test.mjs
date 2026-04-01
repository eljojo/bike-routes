// name-cluster.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pickClusterName } from './name-cluster.mjs';

const southMarch = JSON.parse(readFileSync(new URL('./fixtures/south-march-trails.json', import.meta.url), 'utf8'));

describe('pickClusterName', () => {
  it('uses park name when Overpass returns a containing area', () => {
    const result = pickClusterName(southMarch.entries, southMarch.park.name);
    assert.equal(result, 'South March Highlands Conservation Forest');
  });

  it('falls back to majority operator when no park name', () => {
    const members = southMarch.entries.map(e => ({ ...e, operator: 'NCC' }));
    assert.equal(pickClusterName(members, null), 'NCC Trails');
  });

  it('falls back to most-ways member when no park and no operator', () => {
    // All south march entries have 1 way each, so first non-generic wins
    assert.equal(pickClusterName(southMarch.entries, null), 'Coconut Tree');
  });

  it('uses majority operator, not unanimous', () => {
    const members = [
      { name: 'A', highway: 'path', operator: 'NCC' },
      { name: 'B', highway: 'path', operator: 'NCC' },
      { name: 'C', highway: 'path', operator: 'Other' },
    ];
    assert.equal(pickClusterName(members, null), 'NCC Trails');
  });

  it('skips operator fallback when no majority', () => {
    const members = [
      { name: 'Coconut Tree', operator: 'NCC' },
      { name: 'Beartree', operator: 'City of Ottawa' },
    ];
    assert.equal(pickClusterName(members, null), 'Coconut Tree');
  });

  it('skips generic names (numeric-only)', () => {
    const members = [
      { name: '12345' },
      { name: 'Good Trail' },
    ];
    assert.equal(pickClusterName(members, null), 'Good Trail');
  });

  it('skips relation-ID names', () => {
    const members = [
      { name: 'relation-99999' },
      { name: 'Real Name' },
    ];
    assert.equal(pickClusterName(members, null), 'Real Name');
  });

  it('uses most-ways member name when no park name', () => {
    const members = [
      { name: 'Short St', highway: 'cycleway', _ways: [[1], [2]] },
      { name: 'Long Avenue', highway: 'cycleway', _ways: [[1], [2], [3], [4], [5]] },
      { name: 'Tiny Rd', highway: 'cycleway', _ways: [[1]] },
    ];
    assert.equal(pickClusterName(members, null), 'Long Avenue');
  });

  it('still uses park name for trail clusters', () => {
    const members = [
      { name: 'Trail A', highway: 'path', _ways: [[1]] },
      { name: 'Trail B', highway: 'path', _ways: [[1], [2], [3]] },
    ];
    assert.equal(pickClusterName(members, 'Big Forest Park'), 'Big Forest Park');
  });

  it('uses operator for trail clusters without park', () => {
    const members = [
      { name: 'Trail A', highway: 'path', operator: 'NCC', _ways: [[1]] },
      { name: 'Trail B', highway: 'path', operator: 'NCC', _ways: [[1], [2]] },
    ];
    assert.equal(pickClusterName(members, null), 'NCC Trails');
  });

  it('skips operator naming for urban clusters', () => {
    const members = [
      { name: 'Elgin Street', highway: 'cycleway', operator: 'OC Transpo', _ways: [[1], [2], [3]] },
      { name: 'Rideau Street', highway: 'cycleway', operator: 'OC Transpo', _ways: [[1], [2], [3], [4], [5]] },
    ];
    // Should NOT be "OC Transpo Trails", should use most-ways
    assert.equal(pickClusterName(members, null), 'Rideau Street');
  });
});
