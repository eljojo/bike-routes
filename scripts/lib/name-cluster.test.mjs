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

  it('falls back to longest member name when no park and no operator', () => {
    assert.equal(pickClusterName(southMarch.entries, null), 'DeerDrop Baypass');
  });

  it('uses majority operator, not unanimous', () => {
    const members = [
      { name: 'A', operator: 'NCC' },
      { name: 'B', operator: 'NCC' },
      { name: 'C', operator: 'Other' },
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
});
