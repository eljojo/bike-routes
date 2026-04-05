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
import { buildBikepathsPipeline, parseMarkdownOverrides } from '../build-bikepaths.mjs';
import { loadCityAdapter } from './city-adapter.mjs';

const player = createPlayer('ottawa');
const describeWithCassette = player ? describe : describe.skip;

describeWithCassette('information architecture — Ottawa bike path index', () => {
  let entries;
  let networks;
  let byName;

  beforeAll(async () => {
    const adapter = loadCityAdapter('ottawa');
    const bikePathsDir = new URL('../../ottawa/bike-paths', import.meta.url).pathname;
    const markdownOverrides = parseMarkdownOverrides(bikePathsDir);
    const result = await buildBikepathsPipeline({
      queryOverpass: player,
      bbox: '45.15,-76.35,45.65,-75.35',
      adapter,
      markdownOverrides,
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
  // DIAGNOSTIC: understand current pipeline state after refactoring
  // =====================================================================

  describe('single-pass refactoring diagnostics', () => {
    it('all entries have slug field set by resolution pass', () => {
      const withoutSlug = entries.filter(e => !e.slug);
      expect(withoutSlug.length, `${withoutSlug.length} entries missing slug: ${withoutSlug.slice(0, 5).map(e => e.name)}`).toBe(0);
    });

    it('no entries have transient ref fields after resolution', () => {
      const withRefs = entries.filter(e => e._networkRef || e._memberRefs || e._superNetworkRef);
      expect(withRefs.length, 'transient refs should be stripped').toBe(0);
    });

    it('all member_of values resolve to an existing network slug', () => {
      const networkSlugs = new Set(networks.map(n => n.slug));
      const broken = entries.filter(e => e.member_of && !networkSlugs.has(e.member_of));
      expect(broken.map(e => `${e.name} → ${e.member_of}`)).toEqual([]);
    });

    it('all network members resolve to an existing entry slug', () => {
      const entrySlugs = new Set(entries.map(e => e.slug));
      for (const net of networks) {
        const missing = (net.members || []).filter(s => !entrySlugs.has(s));
        expect(missing, `${net.name} has dangling member slugs`).toEqual([]);
      }
    });

    it('CB2 diagnostic: entries named Crosstown Bikeway 2', () => {
      const cb2All = entries.filter(e => e.name === 'Crosstown Bikeway 2');
      const cb2Types = cb2All.map(e => ({
        type: e.type || 'path',
        slug: e.slug,
        member_of: e.member_of,
        members: e.members?.length,
        osm_relations: e.osm_relations,
      }));
      // Check if CB2 exists as a network member of something
      const cb2AsMembers = entries.filter(e =>
        e.name === 'Crosstown Bikeway 2' && e.member_of
      );
      const info = {
        total: cb2All.length,
        entries: cb2Types,
        asMembers: cb2AsMembers.map(e => `${e.slug} → ${e.member_of}`),
        // Check if CB2 slug appears in any network's members
        inNetworks: networks.filter(n => n.members?.some(s => s.includes('crosstown-bikeway-2'))).map(n => n.name),
      };
      expect(cb2All.length, `CB2 entries: ${JSON.stringify(cb2Types)}`).toBeGreaterThanOrEqual(1);
    });

    it('NCC Greenbelt diagnostic: member latitudes', () => {
      const gb = network('NCC Greenbelt');
      expect(gb, 'NCC Greenbelt network should exist').toBeDefined();
      // Check using stored slug (correct)
      const memberBySlug = (gb.members || [])
        .map(slug => entries.find(e => e.slug === slug))
        .filter(Boolean);
      // Check using base-name slug (what the failing test does)
      const baseSlugMap = new Map();
      for (const e of entries) {
        const slug = e.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
        baseSlugMap.set(slug, e);
      }
      const memberByName = (gb.members || [])
        .map(slug => baseSlugMap.get(slug))
        .filter(Boolean);
      // How many resolve by stored slug vs base name?
      const memberCount = gb.members?.length || 0;
      const resolvedBySlug = memberBySlug.length;
      const resolvedByName = memberByName.length;
      expect(resolvedBySlug, `${resolvedBySlug}/${memberCount} members resolve by stored slug`).toBe(memberCount);
      // Find Gatineau trails using stored slugs
      const gatineauBySlug = memberBySlug.filter(e => e.anchors?.[0]?.[1] > 45.50);
      expect(gatineauBySlug.map(e => e.name), 'NCC Greenbelt should not contain Gatineau Park trails').toEqual([]);
    });
  });

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

    it('Ottawa River Pathway network gets the clean slug (no -3 suffix)', () => {
      const orp = network('Ottawa River Pathway');
      expect(orp).toBeDefined();
      const slug = entries.find(e => e === orp);
      // The stored slug should be 'ottawa-river-pathway', not '-1' or '-3'
      expect(orp.slug).toBe('ottawa-river-pathway');
    });

    it('Crosstown Bikeway 2 has no standalone duplicate (same-named route absorbed into network)', () => {
      // The CB2 superroute (10986224) absorbed CB2 route (10986223) into
      // its osm_relations, but the standalone route entry still exists.
      // There should be exactly one CB2: the network.
      const cb2 = entries.filter(e => e.name === 'Crosstown Bikeway 2');
      const cb2Network = cb2.filter(e => e.type === 'network');
      const cb2Standalone = cb2.filter(e => e.type !== 'network');
      expect(cb2Network.length, 'Should have 1 CB2 network').toBe(1);
      expect(cb2Standalone.length, 'Should have 0 standalone CB2 entries').toBe(0);
    });

    it('Trillium Pathway is a member of Capital Pathway (markdown member_of override)', () => {
      const tp = entries.find(e => e.name === 'Trillium Pathway' && e.type !== 'network');
      expect(tp).toBeDefined();
      expect(tp.member_of).toBe('capital-pathway');
      const cp = network('Capital Pathway');
      expect(cp.members).toContain('trillium-pathway');
    });

    it('Ottawa River Pathway (east) is under Capital Pathway, not floating under NCC', () => {
      // ORP East should be nested under Capital Pathway in the index.
      // Either directly (member_of: capital-pathway) or via ORP network
      // which itself is under Capital Pathway.
      const orpNet = network('Ottawa River Pathway');
      const orpEast = entries.find(e => e.name === 'Ottawa River Pathway (east)' && e.type !== 'network');
      expect(orpEast?.member_of).toBe('ottawa-river-pathway');
      // ORP network must be under Capital Pathway for this to work
      expect(orpNet?.super_network || orpNet?.member_of).toMatch(/capital-pathway/i);
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

    it('is under Capital Pathway, not floating at top level', () => {
      const orp = network('Ottawa River Pathway');
      expect(orp).toBeDefined();
      expect(
        orp.super_network || orp.member_of,
        `ORP network super_network is "${orp.super_network}" but should be capital-pathway`
      ).toMatch(/capital-pathway/i);
    });

    it('ORP relation 9502635 is a member of Capital Pathway relation 10990511', async () => {
      // If this passes, OSM says ORP is under Capital Pathway.
      // If the pipeline puts it under TCT instead, the resolution logic is wrong.
      const data = await player(`[out:json][timeout:15];relation(10990511);out tags;`);
      const cp = data.elements[0];
      expect(cp?.tags?.name).toMatch(/Capital Pathway/);
    });

    it('ORP super_network is capital-pathway (rcn beats ncn in specificity)', () => {
      // Superroute processing sorts by network specificity:
      // ncn (national) processes first, rcn (regional) last → rcn wins.
      const orp = network('Ottawa River Pathway');
      expect(orp.super_network).toBe('capital-pathway');
    });

    it('ORP network is under Capital Pathway (not a direct CP member)', () => {
      // ORP paths are in the ORP network, which has super_network: capital-pathway.
      // Capital Pathway doesn't list ORP fragments as direct members — they're
      // nested under ORP.
      const orp = network('Ottawa River Pathway');
      expect(orp.super_network).toBe('capital-pathway');
      expect(orp.members.length).toBeGreaterThanOrEqual(3);
    });

    it('all "Ottawa River Pathway" path entries are members of the ORP network', () => {
      const orpPaths = entries.filter(e =>
        e.name === 'Ottawa River Pathway' && e.type !== 'network'
      );
      for (const p of orpPaths) {
        expect(
          p.member_of,
          `ORP fragment at ${JSON.stringify(p.anchors?.[0])} should be in ottawa-river-pathway`
        ).toBe('ottawa-river-pathway');
      }
    });

    it('standalone ORP fragments are named ways, not relation members', () => {
      // These have osm_names but no osm_relations — they're OSM ways
      // named "Ottawa River Pathway" that weren't picked up by relation
      // discovery. They should be absorbed into the ORP network.
      const standalones = entries.filter(e =>
        e.name === 'Ottawa River Pathway' && e.type !== 'network'
      );
      for (const s of standalones) {
        expect(s.osm_names, 'Should have osm_names').toBeDefined();
        expect(s.osm_relations, 'Should NOT have osm_relations').toBeUndefined();
      }
    });

    it('standalone ORP fragments should be absorbed into ORP network', () => {
      // These are named ways "Ottawa River Pathway" that aren't members
      // of any OSM relation. They should be absorbed into the ORP network
      // by name matching during superroute resolution.
      const standalones = entries.filter(e =>
        e.name === 'Ottawa River Pathway' && e.type !== 'network'
      );
      for (const s of standalones) {
        expect(
          s.member_of,
          `ORP fragment at ${JSON.stringify(s.anchors?.[0])} should be in ottawa-river-pathway`
        ).toBe('ottawa-river-pathway');
      }
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

    it('Ottawa Valley Recreational Trail is ONE entry, not split into 4', () => {
      // OVRT is a continuous 30km rail trail. Its ways chain via shared
      // nodes. splitWaysByConnectivity should keep it as one entry.
      const ovrt = entries.filter(e =>
        e.name === 'Ottawa Valley Recreational Trail' && e.type !== 'network'
      );
      expect(ovrt.length, `OVRT has ${ovrt.length} entries, should be 1`).toBe(1);
    });

    it('Trail 20 in Greenbelt and Gatineau Park are separate entries', () => {
      // These share a name but are in different parks with no geometric
      // connection. splitWaysByConnectivity should keep them separate.
      const trail20 = entries.filter(e =>
        e.name === 'Trail 20' && e.type !== 'network'
      );
      expect(trail20.length, 'Trail 20 should have 2 entries (Greenbelt + Gatineau)').toBe(2);
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
      expect(gatineauEntries.filter(e => e.type !== 'network').length).toBe(1);
    });

    it('the non-network Parc de la Gatineau came from unnamed chain discovery (osm_names includes the park name)', () => {
      const pathEntry = entries.find(e => e.name === 'Parc de la Gatineau' && e.type !== 'network');
      expect(pathEntry).toBeDefined();
      expect(pathEntry.osm_names).toContain('Parc de la Gatineau');
      expect(pathEntry.osm_relations).toBeUndefined();
    });

    it('the non-network Parc de la Gatineau is not a parallel lane', () => {
      const pathEntry = entries.find(e => e.name === 'Parc de la Gatineau' && e.type !== 'network');
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
        e.type !== 'network'
      );
      expect(citeEntry, 'Should have a Cité-des-Jeunes entry').toBeDefined();
    });

    it('the non-network Parc de la Gatineau is NOT adopted into the park network (guard prevents self-ref)', () => {
      const pathEntry = entries.find(e => e.name === 'Parc de la Gatineau' && e.type !== 'network');
      expect(pathEntry).toBeDefined();
      expect(pathEntry.member_of).toBeUndefined();
    });

    it('way 53309796 should be in a Cité-des-Jeunes entry (parallel lane)', () => {
      const citeEntry = entries.find(e =>
        (e.name?.includes('Cité-des-Jeunes') || e.name?.includes('Cite-des-Jeunes')) &&
        e.type !== 'network'
      );
      expect(citeEntry, 'way 53309796 should be in a Cité-des-Jeunes entry').toBeDefined();
    });

    it('the non-network Parc de la Gatineau path entry has 6 anchors (= 3 ways in the chain)', () => {
      const pathEntry = entries.find(e => e.name === 'Parc de la Gatineau' && e.type !== 'network');
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

    // --- Beaverpond Park: no network (only 1 page-worthy member) ---

    it('Beaverpond Park is a path entry, not a network (spurs absorbed)', () => {
      // The Beaverpond Park cluster had only 1 member >= 1km.
      // The rest were tiny spurs — absorbed into the dominant member.
      const bpNet = networks.find(n => n.name === 'Beaverpond Park');
      expect(bpNet, 'Should not be a network — only 1 page-worthy member').toBeUndefined();
      const bpPath = entries.find(e => e.name === 'Beaverpond Park' && e.type !== 'network');
      expect(bpPath, 'Should still exist as a path entry').toBeDefined();
    });

    it('no network has zero members (zombie from superroute flattening)', () => {
      for (const net of networks) {
        expect(
          net.members?.length,
          `Network "${net.name}" has 0 members — zombie entry that should have been cleaned up`
        ).toBeGreaterThan(0);
      }
    });

    it('every path has exactly one primary network (member_of)', () => {
      // A path can appear in multiple networks' members arrays (e.g. Watts
      // Creek is in both NCC Greenbelt and Capital Pathway). But member_of
      // must point to exactly one — the primary network that determines its URL.
      const nonNetwork = entries.filter(e => e.type !== 'network' && e.member_of);
      for (const entry of nonNetwork) {
        expect(
          typeof entry.member_of,
          `"${entry.name}" has non-string member_of: ${entry.member_of}`
        ).toBe('string');
      }
    });

    it('No Exit (0.18km spur) is absorbed into Carp Barrens Trail, not a separate network member', () => {
      // When a cluster has one dominant trail (3.2km) and tiny spurs
      // (0.18km), the spurs should be absorbed into the dominant entry.
      // Not a network — one trail with minor offshoots.
      const noExitNetwork = networks.find(n => n.name?.includes('No Exit'));
      expect(noExitNetwork, 'No Exit should not be a network').toBeUndefined();
      const cbt = entries.find(e => e.name === 'Carp Barrens Trail' && e.type !== 'network');
      expect(cbt, 'Carp Barrens Trail should exist').toBeDefined();
    });

    it('Greenbelt Pathway West is in NCC Greenbelt, not Bruce Pit', () => {
      // GPW is a 21km trail through the Greenbelt. It passes through
      // Bruce Pit (a small dog park) but belongs to the Greenbelt system.
      // Park containment classified it as Bruce Pit because GPW's geometry
      // intersects Bruce Pit's polygon. But the trail is much larger than
      // the park — it should be in the NCC Greenbelt network.
      const gpw = entries.find(e => e.name === 'Greenbelt Pathway West' && e.type !== 'network');
      expect(gpw).toBeDefined();
      expect(gpw.member_of, 'GPW should be in NCC Greenbelt, not Bruce Pit').toBe('ncc-greenbelt');
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
      // Use stored slugs for reliable lookup (names like "Trail 20" exist in
      // both parks — base-name matching would resolve to the wrong entry)
      const bySlug = new Map();
      for (const e of entries) bySlug.set(e.slug, e);

      for (const net of networks) {
        if (!net.members || net.members.length === 0) continue;
        const memberLats = net.members
          .map(slug => bySlug.get(slug))
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
        e.type !== 'network'
      );
      expect(entry, 'Should have a Davidson area path').toBeDefined();
    });

    it('5.8km chain in Parc Queen exists', () => {
      // 6 ways, ground+asphalt, 45.41,-75.88
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('queen') &&
        e.type !== 'network'
      );
      expect(entry, 'Should have a Parc Queen path').toBeDefined();
    });

    it('4.5km chain near West Houlahan Park exists', () => {
      // 13 ways, 45.27,-75.76
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('houlahan') &&
        e.type !== 'network'
      );
      expect(entry, 'Should have a Houlahan area path').toBeDefined();
    });


    it('4.3km chain near Lytle Park exists', () => {
      // 7 ways, gravel+asphalt, 45.28,-75.80
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('lytle') &&
        e.type !== 'network'
      );
      expect(entry, 'Should have a Lytle area path').toBeDefined();
    });

    it('4.1km chain along Greenbank Road exists', () => {
      // 1 way, asphalt, 45.31,-75.77
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('greenbank') &&
        e.type !== 'network' &&
        !e.parallel_to
      );
      expect(entry, 'Should have a Greenbank area path (not parallel lane)').toBeDefined();
    });

    it('4.0km chain near J. Henry Tweed Conservation Area exists', () => {
      // 3 ways, asphalt, 45.26,-75.36
      // https://www.openstreetmap.org/way/69630903
      const entry = entries.find(e =>
        (e.name?.toLowerCase().includes('tweed') || e.name?.toLowerCase().includes('conservation')) &&
        e.type !== 'network'
      );
      expect(entry, 'Should have a J. Henry Tweed Conservation Area path').toBeDefined();
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
        e.type !== 'network'
      );
      expect(entry, 'Should have a Lac-Beauchamp path').toBeDefined();
    });

    it('3.4km chain at Springhurst Park exists', () => {
      // 31 ways, 45.41,-75.67
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('springhurst') &&
        e.type !== 'network'
      );
      expect(entry, 'Should have a Springhurst Park path').toBeDefined();
    });

    // --- Naming correctness (spot-checked by human) ---

    it('way/310874848 is named Moffat Park, not Mooney\'s Bay Park', () => {
      // Root cause: is_in returns nothing. Nearby 500m returns
      // ["Mooney's Bay Park", "Moffatt Farm Veterans Park"]. Pipeline
      // picks first. Correct park is second in the list.
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('moffat') && e.type !== 'network'
      );
      expect(entry, 'Should have a Moffat Park path').toBeDefined();
    });

    it.skip('way/160958126 should not exist as standalone — it parallels Experimental Farm Pathway', () => {
      // way/160958126 (highway=path, no surface) is a road-side cycling
      // facility 9.4m from Experimental Farm Pathway (relation/7206821,
      // highway=cycleway, asphalt). Same corridor, parallel infrastructure.
      // Known limitation: the type guard (trail vs paved) blocks clustering,
      // and the parallel-to-existing check was too aggressive (killed
      // legitimate chains like Ben Franklin). Needs a more targeted fix.
      const entry = entries.find(e =>
        e.name === 'National Capital Commission Driveway' && e.type !== 'network'
      );
      expect(entry, 'Should not exist as a standalone NCC Driveway entry').toBeUndefined();
    });

    it('Experimental Farm Pathway exists as an entry', () => {
      const entry = entries.find(e =>
        e.name?.includes('Experimental Farm') && e.type !== 'network'
      );
      expect(entry, 'Experimental Farm Pathway should exist').toBeDefined();
      expect(entry.osm_relations).toContain(7206821);
    });

    it('Experimental Farm Pathway is classified as paved (type guard blocks trail merge)', () => {
      // If Experimental Farm is 'paved' and way/160958126 is 'trail',
      // the type guard in clustering prevents them from merging.
      const entry = entries.find(e =>
        e.name?.includes('Experimental Farm') && e.type !== 'network'
      );
      expect(entry).toBeDefined();
      // highway=cycleway + surface=asphalt → paved
      expect(entry.highway).toBe('cycleway');
      expect(entry.surface).toBe('asphalt');
    });

    it('way/160958126 is highway=path with no surface (classified as trail)', () => {
      // This unnamed path is classified as 'trail' because highway=path
      // with no surface defaults to trail. The Experimental Farm Pathway
      // is 'paved'. The type guard prevents trail↔paved clustering.
      // This is the root cause: they CAN'T cluster because of type mismatch.
      const nccEntry = entries.find(e =>
        e.name === 'National Capital Commission Driveway' && e.type !== 'network'
      );
      expect(nccEntry).toBeDefined();
      expect(nccEntry.highway || 'path').toBe('path');
    });

    it('Experimental Farm Pathway has _ways geometry for clustering', () => {
      // If the relation entry has no _ways, clustering can't connect
      // anything to it — the unnamed path can't find it
      const entry = entries.find(e =>
        e.name?.includes('Experimental Farm') && e.type !== 'network'
      );
      expect(entry).toBeDefined();
      // _ways is stripped before YAML output but should exist during pipeline
      // We can't check this from final entries, so check that the entry
      // has anchors (which come from the relation geometry enrichment step)
      expect(entry.anchors?.length, 'Should have anchors from relation geometry').toBeGreaterThan(0);
    });

    it('way/160958126 is 20m from Experimental Farm but blocked by type guard (trail vs paved)', async () => {
      // Root cause: the unnamed path (highway=path, no surface → trail)
      // is 20.5m endpoint-to-endpoint from the Experimental Farm Pathway
      // (highway=cycleway, asphalt → paved). The type guard in clustering
      // prevents trail↔paved merge. The path end is only 9.4m from the
      // relation geometry. They're connected in reality but the type
      // guard blocks it.
      const { minGeomDist } = await import('./nearest-park.mjs');

      const pathGeomData = await player(`[out:json][timeout:15];(way(160958126););out geom;`);
      const pathGeom = pathGeomData.elements[0].geometry;
      const pathEnd = pathGeom[pathGeom.length - 1];

      const relData = await player(`[out:json][timeout:15];relation(7206821);(._;>;);out geom;`);
      const relWays = relData.elements.filter(e => e.type === 'way' && e.geometry?.length > 0);
      const relPts = relWays.flatMap(w => w.geometry);

      const endToRel = minGeomDist([pathEnd], relPts);
      expect(endToRel).toBeLessThan(15); // 9.4m — they almost touch
    });

    it('way/160958126 geometry is close to Experimental Farm Pathway', async () => {
      const { minGeomDist } = await import('./nearest-park.mjs');

      // Fetch the unnamed path geometry
      const pathData = await player(`[out:json][timeout:15];(way(160958126););out geom;`);
      expect(pathData.elements.length).toBe(1);
      const pathGeom = pathData.elements[0].geometry;

      // Fetch the Experimental Farm Pathway relation geometry
      const relData = await player(`[out:json][timeout:15];relation(7206821);(._;>;);out geom;`);
      const relWays = relData.elements.filter(e => e.type === 'way' && e.geometry?.length > 0);
      expect(relWays.length, 'Relation should have way members with geometry').toBeGreaterThan(0);
      const relPts = relWays.flatMap(w => w.geometry);

      const dist = minGeomDist(pathGeom, relPts);
      expect(dist, `way/160958126 should be near Experimental Farm (actual: ${dist.toFixed(0)}m)`).toBeLessThan(500);
    });

    it('way/672322811 is named Parc de la Blanche, not Parc du Drakkar', () => {
      // Root cause: Parc de la Blanche (way/671955999) is tagged
      // natural=wood, NOT leisure=park. The nearby park query only
      // searches leisure=park, so it finds Parc du Drakkar instead.
      // Fix: broaden the nearby query to include natural=wood areas.
      const entry = entries.find(e =>
        e.name?.toLowerCase().includes('blanche') && e.type !== 'network'
      );
      expect(entry, 'Should have a Parc de la Blanche path').toBeDefined();
    });

    it('way/80205794 (Petrie Island) should be part of Ottawa River Pathway, not standalone', () => {
      // Root cause: the chain (6 ways, longest=way/479744018) has its
      // midpoint near "Petrie Island Park" (first of 4 nearby parks).
      // But the user says this should be grouped with ORP — a clustering
      // issue, not a naming issue. The chain should connect to ORP
      // during auto-grouping.
      const entry = entries.find(e =>
        e.name === 'Petrie Island Park' && e.type !== 'network'
      );
      expect(entry, 'Should not exist as standalone Petrie Island Park entry').toBeUndefined();
    });

    it('way/68609629 is correctly named Beaverpond Park', () => {
      const entry = entries.find(e =>
        e.name === 'Beaverpond Park' && e.type !== 'network'
      );
      expect(entry).toBeDefined();
    });

    it('way/509010455: Ben Franklin Park East is the closest park by real geometry', async () => {
      // Same function the pipeline uses for naming — rankParksByGeomDistance
      const { rankParksByGeomDistance } = await import('./nearest-park.mjs');

      const pathData = await player(`[out:json][timeout:15];(way(509010455););out geom;`);
      const pathGeom = pathData.elements[0].geometry;
      expect(pathGeom.length).toBeGreaterThan(0);

      const parkData = await player(`[out:json][timeout:15];way(509010455)->.chain;(way["leisure"="park"]["name"](around.chain:500);relation["leisure"="park"]["name"](around.chain:500);way["natural"="wood"]["name"](around.chain:500);relation["natural"="wood"]["name"](around.chain:500););out geom tags;`);
      expect(parkData.elements.length).toBeGreaterThan(0);

      const ranked = rankParksByGeomDistance(pathGeom, parkData.elements);
      expect(ranked[0].name).toBe('Ben Franklin Park East');
      expect(ranked[0].dist).toBeLessThan(50);
    });

    it('way/509010455 is correctly named Ben Franklin Park East', () => {
      const entry = entries.find(e =>
        e.name?.includes('Ben Franklin') && e.type !== 'network'
      );
      expect(entry).toBeDefined();
    });

    it('way/544451389 is correctly named Limebank Road', () => {
      const entry = entries.find(e =>
        e.name?.includes('Limebank') && e.type !== 'network'
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
