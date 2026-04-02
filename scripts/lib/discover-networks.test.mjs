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
  it('discovers Capital Pathway from fixture', async () => {
    const superroutes = fixture.elements.filter(el => el.tags?.type === 'superroute');
    const allRelations = fixture.elements.filter(el => el.type === 'relation');
    const mockQuery = async (q) => {
      if (q.includes('"superroute"')) return { elements: superroutes };
      return { elements: allRelations };
    };

    const networks = await discoverNetworks({ bbox: '45.2,-76.4,45.6,-75.3', queryOverpass: mockQuery });
    const cp = networks.find(n => n.name === 'Capital Pathway');
    expect(cp).toBeDefined();
    expect(cp._member_relations.length).toBeGreaterThan(5);
    expect(cp.wikidata).toBe('Q5035630');
  });
});
