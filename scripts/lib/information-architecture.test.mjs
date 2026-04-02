// information-architecture.test.mjs
//
// Pipeline-level assertions about how the site's bike path index should
// look to a human. Each test encodes a design decision about what makes
// sense as a network, what should be standalone, and what should NOT be
// a network. Tests that fail represent work still to do.
//
// Record cassette: RECORD_OVERPASS=ottawa node scripts/build-bikepaths.mjs --city ottawa

import { describe, it, expect, beforeAll } from 'vitest';
import { createPlayer } from './overpass.mjs';
import { buildBikepathsPipeline } from '../build-bikepaths.mjs';
import { loadCityAdapter } from './city-adapter.mjs';

const player = createPlayer('ottawa');
const describeWithCassette = player ? describe : describe.skip;

describeWithCassette('information architecture — Ottawa bike path index', () => {
  let entries;
  let networks;
  let byName;

  beforeAll(async () => {
    const adapter = loadCityAdapter('ottawa');
    const result = await buildBikepathsPipeline({
      queryOverpass: player,
      bbox: '45.15,-76.35,45.65,-75.35',
      adapter,
    });
    entries = result.entries;
    networks = entries.filter(e => e.type === 'network');
    byName = new Map();
    for (const e of entries) {
      if (!byName.has(e.name)) byName.set(e.name, []);
      byName.get(e.name).push(e);
    }
  }, 30000);

  // Helper: find member_of for an entry by name
  function memberOf(name) {
    const entry = entries.find(e => e.name === name && e.type !== 'network');
    return entry?.member_of;
  }

  // Helper: find network by name
  function network(name) {
    return networks.find(n => n.name === name || n.name?.includes(name));
  }

  // =====================================================================
  // 1. CAPITAL PATHWAY — should be a real network with ~15 member paths
  // =====================================================================

  describe('Capital Pathway network', () => {
    it('exists as a type: network entry', () => {
      expect(network('Capital Pathway')).toBeDefined();
    });

    it('has members', () => {
      const cp = network('Capital Pathway');
      expect(cp?.members?.length).toBeGreaterThanOrEqual(10);
    });

    it('Ottawa River Pathway (east) is a member', () => {
      expect(memberOf('Ottawa River Pathway (east)')).toMatch(/capital-pathway|ottawa-river/i);
    });

    it('Rideau Canal Eastern Pathway is a member', () => {
      expect(memberOf('Rideau Canal Eastern Pathway')).toMatch(/capital-pathway/i);
    });

    it('Rideau Canal Western Pathway is a member', () => {
      const entry = entries.find(e => e.name?.includes('Rideau Canal Western') && e.type !== 'network');
      expect(entry?.member_of).toMatch(/capital-pathway/i);
    });

    it('Experimental Farm Pathway is a member', () => {
      expect(memberOf('Experimental Farm Pathway')).toMatch(/capital-pathway/i);
    });

    it('Rideau River Eastern Pathway is a member', () => {
      expect(memberOf('Rideau River Eastern Pathway')).toMatch(/capital-pathway/i);
    });

    it('Aviation Pathway is a member', () => {
      expect(memberOf('Aviation Pathway')).toMatch(/capital-pathway/i);
    });

    it('Sentier des Voyageurs Pathway is a member', () => {
      expect(memberOf('Sentier des Voyageurs Pathway')).toMatch(/capital-pathway/i);
    });

    it('Pinecrest Creek Pathway is a member', () => {
      expect(memberOf('Pinecrest Creek Pathway')).toMatch(/capital-pathway/i);
    });
  });

  // =====================================================================
  // 2. CROSSTOWN BIKEWAYS — City of Ottawa commuter cycling spines
  // =====================================================================

  describe('Crosstown Bikeways', () => {
    it('Crosstown Bikeway 2 is in a network', () => {
      expect(memberOf('Crosstown Bikeway 2')).toBeDefined();
    });

    it('Crosstown Bikeway 3 is in a network', () => {
      expect(memberOf('Crosstown Bikeway 3')).toBeDefined();
    });

    it('Crosstown Bikeway 5 is in a network', () => {
      expect(memberOf('Crosstown Bikeway 5')).toBeDefined();
    });

    it('Laurier Segregated Bikelane is in a Crosstown network', () => {
      expect(memberOf('Laurier Segregated Bikelane')).toBeDefined();
    });

    it('O\'Connor Bikeway is in a Crosstown network', () => {
      expect(memberOf("O'Connor Bikeway")).toBeDefined();
    });
  });

  // =====================================================================
  // 3. PARK NETWORKS — already working, protect from regressions
  // =====================================================================

  describe('park networks', () => {
    it('Parc de la Gatineau exists with 50+ members', () => {
      const gp = network('Parc de la Gatineau');
      expect(gp).toBeDefined();
      expect(gp.members.length).toBeGreaterThan(50);
    });

    it('NCC Greenbelt exists with 30+ members', () => {
      const gb = network('NCC Greenbelt');
      expect(gb).toBeDefined();
      expect(gb.members.length).toBeGreaterThan(30);
    });

    it('South March Highlands exists with 10+ members', () => {
      const sm = network('South March');
      expect(sm).toBeDefined();
      expect(sm.members.length).toBeGreaterThan(10);
    });

    it('La Boucle MTB exists with 15+ members', () => {
      const lb = network('La Boucle');
      expect(lb).toBeDefined();
      expect(lb.members.length).toBeGreaterThan(15);
    });
  });

  // =====================================================================
  // 4. OTTAWA RIVER PATHWAY — its own network with east/west/TCT
  // =====================================================================

  describe('Ottawa River Pathway network', () => {
    it('exists as a network', () => {
      expect(network('Ottawa River Pathway')).toBeDefined();
    });

    it('has east/west/TCT as members', () => {
      const orp = network('Ottawa River Pathway');
      expect(orp?.members?.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =====================================================================
  // 5. PARALLEL LANES SHOULD NOT BE NETWORKS
  //    Road bike lanes grouped by shared intersection nodes are NOT
  //    trail systems. They should be standalone entries.
  // =====================================================================

  describe('parallel lanes are NOT networks', () => {
    const roadNames = [
      'Sussex Drive', 'Bank Street', 'Montréal Road', 'Ogilvie Road',
      'Island Park Drive', 'Mackenzie King Bridge', 'Lees Avenue',
      'Hawthorne Road', 'Woodroffe Avenue', 'Strandherd Drive',
    ];

    for (const name of roadNames) {
      it(`${name} is NOT a network`, () => {
        const net = networks.find(n => n.name?.startsWith(name));
        expect(net, `${name} should not be a network — it's parallel bike lanes on a road`).toBeUndefined();
      });
    }
  });

  // =====================================================================
  // 6. VOIE VERTE CHELSEA — should be one entry, not 5
  // =====================================================================

  describe('Voie Verte Chelsea', () => {
    it('has at most 2 entries (not 5 typo variants)', () => {
      const vvc = entries.filter(e =>
        e.name?.toLowerCase().includes('voie vert') &&
        e.name?.toLowerCase().includes('chelsea') &&
        e.type !== 'network'
      );
      expect(vvc.length, `Found ${vvc.length} Voie Verte Chelsea entries: ${vvc.map(e => e.name).join(', ')}`).toBeLessThanOrEqual(2);
    });
  });

  // =====================================================================
  // 7. LONG-DISTANCE TRAILS — should be standalone (their own page)
  // =====================================================================

  describe('long-distance trails are standalone', () => {
    it('Prescott-Russell Trail exists', () => {
      const prt = entries.find(e => e.name?.includes('Prescott') && e.name?.includes('Russell') && !e.name?.includes('Link'));
      expect(prt).toBeDefined();
    });

    it('Cycloparc PPJ exists', () => {
      expect(entries.find(e => e.name === 'Cycloparc PPJ')).toBeDefined();
    });

    it('Algonquin Trail exists', () => {
      expect(entries.find(e => e.name === 'Algonquin Trail')).toBeDefined();
    });
  });

  // =====================================================================
  // 8. NO SELF-REFERENCES OR NETWORK-AS-MEMBER (regression guard)
  // =====================================================================

  describe('data integrity', () => {
    it('no network has itself as a member', () => {
      for (const net of networks) {
        if (!net.members) continue;
        const netSlug = net.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
        for (const memberSlug of net.members) {
          expect(memberSlug, `Network "${net.name}" references itself`).not.toBe(netSlug);
        }
      }
    });

    it('no network has another network as a member', () => {
      for (const net of networks) {
        for (const memberSlug of net.members || []) {
          const member = entries.find(e => {
            const s = e.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
              .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
            return s === memberSlug;
          });
          if (member?.type === 'network') {
            expect.fail(`Network "${net.name}" has network "${member.name}" as a member`);
          }
        }
      }
    });

    it('no network mixes Gatineau Park and Greenbelt trails', () => {
      const slugMap = new Map();
      for (const e of entries) {
        const slug = e.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
        slugMap.set(slug, e);
      }

      for (const net of networks) {
        if (!net.members || net.members.length === 0) continue;
        const memberLats = net.members
          .map(slug => slugMap.get(slug))
          .filter(Boolean)
          .map(e => e.anchors?.[0]?.[1])
          .filter(Boolean);
        if (memberLats.length < 2) continue;
        const hasGreenbelt = memberLats.some(lat => lat < 45.40);
        const hasGatineau = memberLats.some(lat => lat > 45.50);
        if (hasGreenbelt && hasGatineau) {
          expect.fail(`Network "${net.name}" mixes Greenbelt and Gatineau Park trails`);
        }
      }
    });
  });

  // =====================================================================
  // 9. NETWORK NAMING — no "Trails" suffix on road networks
  // =====================================================================

  describe('network naming', () => {
    it('no network named "X Trails" for urban roads', () => {
      const roadTrails = networks.filter(n =>
        n.name?.endsWith(' Trails') &&
        n.members?.some(slug => {
          const member = entries.find(e => {
            const s = e.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
              .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
            return s === slug;
          });
          return member?.parallel_to;
        })
      );
      expect(
        roadTrails.length,
        `Found ${roadTrails.length} road networks with "Trails" suffix: ${roadTrails.map(n => n.name).join(', ')}`
      ).toBe(0);
    });
  });
});
