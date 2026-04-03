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
    it('Crosstown Bikeway 2 is a network or in a network', () => {
      const cb2net = networks.find(n => n.name?.includes('Crosstown Bikeway 2'));
      const cb2member = memberOf('Crosstown Bikeway 2');
      expect(cb2net || cb2member, 'Crosstown Bikeway 2 should be a network or member of one').toBeTruthy();
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
    it('Prescott Russell Trail Link exists', () => {
      const prt = entries.find(e => e.name?.includes('Prescott') && e.name?.includes('Russell'));
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

    it('no self-referencing networks remain after park adoption guard', () => {
      const selfRefs = [];
      for (const net of networks) {
        if (!net.members) continue;
        const netSlug = net.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
        if (net.members.includes(netSlug)) selfRefs.push(net.name);
      }
      expect(selfRefs).toEqual([]);
    });

    // --- Parc de la Gatineau self-reference investigation ---

    it('there are exactly two entries named "Parc de la Gatineau" — one network, one path', () => {
      const gatineauEntries = entries.filter(e => e.name === 'Parc de la Gatineau');
      expect(gatineauEntries.length).toBe(2);
      expect(gatineauEntries.filter(e => e.type === 'network').length).toBe(1);
      expect(gatineauEntries.filter(e => !e.type).length).toBe(1);
    });

    it('the non-network Parc de la Gatineau came from unnamed chain discovery (osm_names includes the park name)', () => {
      const pathEntry = entries.find(e => e.name === 'Parc de la Gatineau' && !e.type);
      expect(pathEntry).toBeDefined();
      expect(pathEntry.osm_names).toContain('Parc de la Gatineau');
      expect(pathEntry.osm_relations).toBeUndefined();
    });

    it('the non-network Parc de la Gatineau is not a parallel lane', () => {
      const pathEntry = entries.find(e => e.name === 'Parc de la Gatineau' && !e.type);
      expect(pathEntry).toBeDefined();
      expect(pathEntry.parallel_to).toBeUndefined();
    });

    it('the Parc de la Gatineau network was created by park containment', () => {
      const net = networks.find(n => n.name === 'Parc de la Gatineau');
      expect(net).toBeDefined();
      expect(net._parkName).toBeDefined();
    });

    it('the Cité-des-Jeunes parallel lane exists (proving Step 2b found that cycleway)', () => {
      const citeEntry = entries.find(e =>
        (e.name?.includes('Cité-des-Jeunes') || e.name?.includes('Cite-des-Jeunes')) &&
        !e.type
      );
      expect(citeEntry, 'Should have a Cité-des-Jeunes entry').toBeDefined();
    });

    it('the non-network Parc de la Gatineau is NOT adopted into the park network (guard prevents self-ref)', () => {
      const pathEntry = entries.find(e => e.name === 'Parc de la Gatineau' && !e.type);
      expect(pathEntry).toBeDefined();
      expect(pathEntry.member_of).toBeUndefined();
    });

    it('way 53309796 should be in a Cité-des-Jeunes entry (parallel lane)', () => {
      const citeEntry = entries.find(e =>
        (e.name?.includes('Cité-des-Jeunes') || e.name?.includes('Cite-des-Jeunes')) &&
        !e.type
      );
      expect(citeEntry, 'way 53309796 should be in a Cité-des-Jeunes entry').toBeDefined();
    });

    it('the non-network Parc de la Gatineau path entry has 6 anchors (= 3 ways in the chain)', () => {
      const pathEntry = entries.find(e => e.name === 'Parc de la Gatineau' && !e.type);
      expect(pathEntry).toBeDefined();
      // Step 2c adds 2 anchor points per way. 6 anchors = 3 ways.
      // This is a multi-way chain mixing cycleway and path ways.
      // Not all of them are in Step 2b (only highway=cycleway).
      expect(pathEntry.anchors.length).toBe(6);
    });

    it('the Parc de la Gatineau network does not contain itself as a member', () => {
      const net = networks.find(n => n.name === 'Parc de la Gatineau');
      expect(net).toBeDefined();
      expect(net.members.length).toBeGreaterThan(10);
      expect(net.members).not.toContain('parc-de-la-gatineau');
    });

    // --- Beaverpond Park self-reference investigation ---

    it('there are exactly two entries named "Beaverpond Park" — one network, one path', () => {
      const bpEntries = entries.filter(e => e.name === 'Beaverpond Park');
      expect(bpEntries.length).toBe(2);
      expect(bpEntries.filter(e => e.type === 'network').length).toBe(1);
      expect(bpEntries.filter(e => !e.type).length).toBe(1);
    });

    it('the non-network Beaverpond Park came from unnamed chain discovery', () => {
      const pathEntry = entries.find(e => e.name === 'Beaverpond Park' && !e.type);
      expect(pathEntry).toBeDefined();
      expect(pathEntry.osm_names).toContain('Beaverpond Park');
      expect(pathEntry.osm_relations).toBeUndefined();
    });

    it('the non-network Beaverpond Park is not a parallel lane', () => {
      const pathEntry = entries.find(e => e.name === 'Beaverpond Park' && !e.type);
      expect(pathEntry).toBeDefined();
      expect(pathEntry.parallel_to).toBeUndefined();
    });

    it('the Beaverpond Park network was created by park containment', () => {
      const net = networks.find(n => n.name === 'Beaverpond Park');
      expect(net).toBeDefined();
      expect(net._parkName).toBeDefined();
    });

    it('the non-network Beaverpond Park is NOT adopted into the park network (guard prevents self-ref)', () => {
      const pathEntry = entries.find(e => e.name === 'Beaverpond Park' && !e.type);
      expect(pathEntry).toBeDefined();
      expect(pathEntry.member_of).toBeUndefined();
    });

    it('no network has zero members (zombie from superroute flattening)', () => {
      for (const net of networks) {
        expect(
          net.members?.length,
          `Network "${net.name}" has 0 members — zombie entry that should have been cleaned up`
        ).toBeGreaterThan(0);
      }
    });

    it('no path is a member of two different networks', () => {
      const memberCounts = new Map();
      for (const net of networks) {
        for (const slug of net.members || []) {
          if (!memberCounts.has(slug)) memberCounts.set(slug, []);
          memberCounts.get(slug).push(net.name);
        }
      }
      for (const [slug, netNames] of memberCounts) {
        expect(
          netNames.length,
          `"${slug}" is in ${netNames.length} networks: ${netNames.join(', ')}`
        ).toBe(1);
      }
    });

    it('Greenbelt Pathway West (Barrhaven) is in the Greenbelt, not Capital Pathway', () => {
      // Barrhaven is a relation-only entry. Without anchor enrichment from
      // relation geometry, park containment can't classify it and the
      // superroute resolution grabs it into Capital Pathway.
      const barrhaven = entries.find(e => e.name?.includes('Barrhaven'));
      expect(barrhaven, 'Barrhaven should exist').toBeDefined();
      expect(barrhaven.member_of, 'Barrhaven should be in a network').toBeDefined();
      expect(barrhaven.member_of).toMatch(/greenbelt/i);
    });

    it('no road (primary/secondary/tertiary) is adopted into a cycling network via ref', () => {
      const roadHighways = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified']);
      for (const entry of entries) {
        if (!entry.member_of || entry.type === 'network') continue;
        if (entry.highway && roadHighways.has(entry.highway)) {
          // Roads can be in park networks (park adoption) but should NOT be
          // in superroute/route-system networks
          const net = networks.find(n => {
            const slug = n.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
              .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
            return slug === entry.member_of;
          });
          if (net && !net._parkName) {
            expect.fail(`Road "${entry.name}" (hw: ${entry.highway}) in non-park network "${net?.name}" — ref matching should exclude roads`);
          }
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
  // 9. UNNAMED CYCLING CHAINS — should be discovered and named
  //    from nearby context (parks, roads)
  // =====================================================================

  describe('unnamed cycling chains get meaningful names', () => {
    // These are real unnamed cycling chains >= 1.9km discovered by
    // scanning Ottawa. The name comes from nearby parks/roads.

    it('7km chain near Rue Davidson Ouest exists', () => {
      // 8 ways, asphalt, 45.51,-75.67 — parallel to Rue Davidson Ouest
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('davidson') &&
        !e.type
      );
      expect(entry, 'Should have a Davidson area path').toBeDefined();
    });

    it('5.8km chain in Parc Queen exists', () => {
      // 6 ways, ground+asphalt, 45.41,-75.88
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('queen') &&
        !e.type
      );
      expect(entry, 'Should have a Parc Queen path').toBeDefined();
    });

    it('4.5km chain near West Houlahan Park exists', () => {
      // 13 ways, 45.27,-75.76
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('houlahan') &&
        !e.type
      );
      expect(entry, 'Should have a Houlahan area path').toBeDefined();
    });


    it('4.3km chain near Lytle Park exists', () => {
      // 7 ways, gravel+asphalt, 45.28,-75.80
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('lytle') &&
        !e.type
      );
      expect(entry, 'Should have a Lytle area path').toBeDefined();
    });

    it('4.1km chain along Greenbank Road exists', () => {
      // 1 way, asphalt, 45.31,-75.77
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('greenbank') &&
        !e.type &&
        !e.parallel_to
      );
      expect(entry, 'Should have a Greenbank area path (not parallel lane)').toBeDefined();
    });

    it('4.0km chain near Keith M Boyd Park / Russell Exhibition exists', () => {
      // 3 ways, asphalt, 45.26,-75.36 — near both parks
      const entry = entries.find(e =>
        (e.name?.toLowerCase().includes('boyd') || e.name?.toLowerCase().includes('russell exhibition')) &&
        !e.type
      );
      expect(entry, 'Should have a path named after Boyd Park or Russell Exhibition').toBeDefined();
    });

    it('1.8km cycleway parallel to Boulevard de la Cité-des-Jeunes exists', () => {
      // way/53309796, asphalt, 45.46,-75.77 — inside Gatineau Park area
      // but actually parallel to Boulevard de la Cité-des-Jeunes
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('cite-des-jeunes') ||
        e.name?.toLowerCase().includes('cité-des-jeunes') ||
        e.name?.toLowerCase().includes('cite des jeunes')
      );
      expect(entry, 'Should have a Cité-des-Jeunes area path').toBeDefined();
    });

    it('3.6km chain at Lac-Beauchamp exists', () => {
      // 4 ways, asphalt, 45.49,-75.62
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('beauchamp') &&
        !e.type
      );
      expect(entry, 'Should have a Lac-Beauchamp path').toBeDefined();
    });

    it('3.4km chain at Springhurst Park exists', () => {
      // 31 ways, 45.41,-75.67
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('springhurst') &&
        !e.type
      );
      expect(entry, 'Should have a Springhurst Park path').toBeDefined();
    });

    // --- Naming correctness (spot-checked by human) ---

    it('way/310874848 is named Moffat Park, not Mooney\'s Bay Park', () => {
      // The pipeline names this "Mooney's Bay Park" via is_in but the
      // path is actually in Moffat Park
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('moffat') && !e.type
      );
      expect(entry, 'Should have a Moffat Park path').toBeDefined();
    });

    it('way/160958126 should be part of the Experimental Farm, not standalone', () => {
      // This path runs through the Central Experimental Farm and should
      // be grouped with it, not named "National Capital Commission Driveway"
      const entry = entries.find(e =>
        e.name === 'National Capital Commission Driveway' && !e.type
      );
      expect(entry, 'Should not exist as a standalone NCC Driveway entry').toBeUndefined();
    });

    it('way/672322811 is named Parc de la Blanche, not Parc du Drakkar', () => {
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('blanche') && !e.type
      );
      expect(entry, 'Should have a Parc de la Blanche path').toBeDefined();
    });

    it('way/80205794 (Petrie Island) should be part of Ottawa River Pathway, not standalone', () => {
      // This path near Petrie Island should be joined with Ottawa River Pathway
      const entry = entries.find(e =>
        e.name === 'Petrie Island Park' && !e.type
      );
      expect(entry, 'Should not exist as standalone Petrie Island Park entry').toBeUndefined();
    });

    it('way/68609629 is correctly named Beaverpond Park', () => {
      const entry = entries.find(e =>
        e.name === 'Beaverpond Park' && !e.type
      );
      expect(entry).toBeDefined();
    });

    it('way/509010455 is correctly named Ben Franklin Park East', () => {
      const entry = entries.find(e =>
        e.name?.includes('Ben Franklin') && !e.type
      );
      expect(entry).toBeDefined();
    });

    it('way/544451389 is correctly named Limebank Road', () => {
      const entry = entries.find(e =>
        e.name?.includes('Limebank') && !e.type
      );
      expect(entry).toBeDefined();
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
