import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverNetworks, expandSuperroute, buildNetworkEntry } from './discover-networks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'capital-pathway-superroute.json'), 'utf8')
);

describe('expandSuperroute', () => {
  it('recursively expands nested superroutes to leaf routes', async () => {
    const allRelations = fixture.elements.filter(el => el.type === 'relation');

    // Build a lookup: parentId -> child relations (from members array)
    const childrenByParent = new Map();
    for (const rel of allRelations) {
      const childIds = rel.members.filter(m => m.type === 'relation').map(m => m.ref);
      if (childIds.length > 0) {
        const childRelations = childIds
          .map(id => allRelations.find(r => r.id === id))
          .filter(Boolean);
        childrenByParent.set(rel.id, childRelations);
      }
    }

    // Route each query to the correct children by extracting the relation ID from the query
    const mockQuery = async (q) => {
      const match = q.match(/relation\((\d+)\)/);
      if (match) {
        const id = parseInt(match[1], 10);
        return { elements: childrenByParent.get(id) ?? [] };
      }
      return { elements: [] };
    };

    const leaves = await expandSuperroute(10990511, mockQuery);

    // No superroutes in result — all flattened to leaf routes
    const superroutes = leaves.filter(l => l.tags?.type === 'superroute');
    expect(superroutes).toHaveLength(0);

    // Aviation Pathway (7369758) — direct child
    expect(leaves.some(l => l.id === 7369758)).toBe(true);

    // Ottawa River Pathway (east) (7174864) — child of sub-superroute
    expect(leaves.some(l => l.id === 7174864)).toBe(true);
  });

  it('handles cycles without infinite recursion', async () => {
    const mockQuery = async (q) => {
      if (q.includes('relation(1)')) {
        return { elements: [{ type: 'relation', id: 2, tags: { type: 'superroute', name: 'B' }, members: [] }] };
      }
      if (q.includes('relation(2)')) {
        return { elements: [{ type: 'relation', id: 1, tags: { type: 'superroute', name: 'A' }, members: [] }] };
      }
      return { elements: [] };
    };
    const leaves = await expandSuperroute(1, mockQuery);
    expect(leaves).toHaveLength(0);
  });
});

describe('buildNetworkEntry', () => {
  it('builds a bikepaths.yml network entry from superroute data', () => {
    const entry = buildNetworkEntry({
      id: 10990511,
      name: 'Capital Pathway',
      tags: {
        type: 'superroute', route: 'bicycle', network: 'rcn',
        operator: 'NCC', wikidata: 'Q5035630', wikipedia: 'en:Capital Pathway',
        'name:en': 'Capital Pathway', 'name:fr': 'Sentier de la capitale',
        cycle_network: 'CA:ON:NCC',
      },
      memberRoutes: [
        { id: 7369758, name: 'Aviation Pathway' },
        { id: 7206766, name: 'Rideau Canal Eastern Pathway' },
      ],
    });

    expect(entry.type).toBe('network');
    expect(entry.osm_relations).toEqual([10990511]);
    expect(entry.wikidata).toBe('Q5035630');
    expect(entry.name_en).toBe('Capital Pathway');
    expect(entry.name_fr).toBe('Sentier de la capitale');
    // _member_relations stores relation IDs — slug resolution happens later
    expect(entry._member_relations).toEqual([7369758, 7206766]);
  });
});

describe('discoverNetworks', () => {
  // Helper: build a mock that returns the right children for each relation
  function buildMockFromFixture() {
    const allRelations = fixture.elements.filter(el => el.type === 'relation');
    const childrenByParent = new Map();
    for (const rel of allRelations) {
      const childIds = rel.members?.filter(m => m.type === 'relation').map(m => m.ref) || [];
      if (childIds.length > 0) {
        childrenByParent.set(rel.id, childIds.map(id => allRelations.find(r => r.id === id)).filter(Boolean));
      }
    }
    const superroutes = allRelations.filter(el => el.tags?.type === 'superroute');

    return async (q) => {
      if (q.includes('"superroute"')) return { elements: superroutes };
      const match = q.match(/relation\((\d+)\)/);
      if (match) {
        const id = parseInt(match[1], 10);
        return { elements: childrenByParent.get(id) ?? [] };
      }
      return { elements: [] };
    };
  }

  it('discovers Capital Pathway from fixture', async () => {
    const mockQuery = buildMockFromFixture();
    const networks = await discoverNetworks({ bbox: '45.2,-76.4,45.6,-75.3', queryOverpass: mockQuery });
    const cp = networks.find(n => n.name === 'Capital Pathway');
    expect(cp).toBeDefined();
    expect(cp._member_relations.length).toBeGreaterThan(5);
    expect(cp.wikidata).toBe('Q5035630');
  });

  it('flattens sub-superroutes into parent — Ottawa River Pathway is NOT a network', async () => {
    // Ottawa River Pathway (9502635) is a sub-superroute of Capital Pathway.
    // It should NOT appear as a network — its children should be direct
    // members of Capital Pathway instead.
    const mockQuery = buildMockFromFixture();
    const networks = await discoverNetworks({ bbox: '45.2,-76.4,45.6,-75.3', queryOverpass: mockQuery });
    const orp = networks.find(n => n.name === 'Ottawa River Pathway');
    expect(orp).toBeUndefined();

    // But Ottawa River Pathway's children should be Capital Pathway members
    const cp = networks.find(n => n.name === 'Capital Pathway');
    // 7174864 = Ottawa River Pathway (east), child of the sub-superroute
    expect(cp._member_relations).toContain(7174864);
  });

  it('absorbs same-named child route into network entry', async () => {
    // Simulate: "Crosstown Bikeway 2" superroute contains a child also
    // named "Crosstown Bikeway 2" plus two other routes.
    // The same-named child should be absorbed (relation ID merged into
    // network, not a separate member). Needs 2+ distinct to pass min-members.
    const mockQuery = async (q) => {
      if (q.includes('"superroute"')) {
        return { elements: [{
          type: 'relation', id: 100,
          tags: { type: 'superroute', route: 'bicycle', name: 'Crosstown Bikeway 2' },
          members: [
            { type: 'relation', ref: 101 },
            { type: 'relation', ref: 102 },
            { type: 'relation', ref: 103 },
          ],
        }] };
      }
      if (q.includes('relation(100)')) {
        return { elements: [
          { type: 'relation', id: 101, tags: { type: 'route', name: 'Crosstown Bikeway 2' } },
          { type: 'relation', id: 102, tags: { type: 'route', name: 'Laurier Segregated Bikelane' } },
          { type: 'relation', id: 103, tags: { type: 'route', name: 'East-West Crosstown Bikeway' } },
        ] };
      }
      return { elements: [] };
    };

    const networks = await discoverNetworks({ bbox: '0,0,1,1', queryOverpass: mockQuery });
    expect(networks).toHaveLength(1);
    const net = networks[0];
    expect(net.name).toBe('Crosstown Bikeway 2');
    // Same-named child (101) absorbed — its ID is in network's osm_relations
    expect(net.osm_relations).toContain(101);
    // Laurier and E-W Crosstown are distinct members
    expect(net._member_relations).toEqual([102, 103]);
    expect(net._member_relations).not.toContain(101);
  });

  it('strips "(super)" from OSM names', async () => {
    const mockQuery = async (q) => {
      if (q.includes('"superroute"')) {
        return { elements: [{
          type: 'relation', id: 200,
          tags: { type: 'superroute', route: 'bicycle', name: 'Big Network (super)' },
          members: [
            { type: 'relation', ref: 201 },
            { type: 'relation', ref: 202 },
          ],
        }] };
      }
      if (q.includes('relation(200)')) {
        return { elements: [
          { type: 'relation', id: 201, tags: { type: 'route', name: 'Algonquin Trail' } },
          { type: 'relation', id: 202, tags: { type: 'route', name: 'OVRT' } },
        ] };
      }
      return { elements: [] };
    };

    const networks = await discoverNetworks({ bbox: '0,0,1,1', queryOverpass: mockQuery });
    expect(networks[0].name).toBe('Big Network');
  });

  it('skips networks with fewer than 2 distinct members', async () => {
    // Superroute with 1 child that has a different name = 1 distinct member
    const mockQuery = async (q) => {
      if (q.includes('"superroute"')) {
        return { elements: [{
          type: 'relation', id: 300,
          tags: { type: 'superroute', route: 'bicycle', name: 'Tiny Network' },
          members: [{ type: 'relation', ref: 301 }],
        }] };
      }
      if (q.includes('relation(300)')) {
        return { elements: [
          { type: 'relation', id: 301, tags: { type: 'route', name: 'Only Child' } },
        ] };
      }
      return { elements: [] };
    };

    const networks = await discoverNetworks({ bbox: '0,0,1,1', queryOverpass: mockQuery });
    expect(networks).toHaveLength(0);
  });
});
