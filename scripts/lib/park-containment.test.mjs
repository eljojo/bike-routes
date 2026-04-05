// park-containment.test.mjs
//
// Pipeline-level test: run buildBikepathsPipeline with recorded Overpass
// cassette, assert that trails end up in the correct park's network.
//
// The cassette is recorded from a real pipeline run:
// RECORD_OVERPASS=lib/fixtures/ottawa-cassette.json node build-bikepaths.mjs --city ottawa

import { describe, it, expect, beforeAll } from 'vitest';
import { createPlayer } from './overpass.mjs';
import { buildBikepathsPipeline } from '../build-bikepaths.mjs';
import { loadCityAdapter } from './city-adapter.mjs';

// Cassette lives in .cache/ (gitignored). Record with:
// RECORD_OVERPASS=ottawa node scripts/build-bikepaths.mjs --city ottawa
const player = createPlayer('ottawa');

// Skip if cassette not recorded yet
const describeWithCassette = player ? describe : describe.skip;

describeWithCassette('pipeline park containment — real Ottawa data', () => {
  let entries;

  // Run the full pipeline once with recorded Overpass data
  beforeAll(async () => {
    const adapter = loadCityAdapter('ottawa');
    const bbox = '45.15,-76.35,45.65,-75.35';

    const result = await buildBikepathsPipeline({
      queryOverpass: player,
      bbox,
      adapter,
      manualEntries: [],
    });
    entries = result.entries;
  }, 30000);

  // Basic sanity
  it('produces entries', () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  it('produces networks', () => {
    const networks = entries.filter(e => e.type === 'network');
    expect(networks.length).toBeGreaterThan(5);
  });

  // -----------------------------------------------------------------------
  // THE BUG: Gatineau Park trails must NOT be in Greenbelt networks
  // -----------------------------------------------------------------------

  it('Trail 22 (Gatineau Park, ~45.50°N) is NOT in a Greenbelt network', () => {
    const trail = entries.find(e => e.name === 'Trail 22');
    expect(trail, 'Trail 22 should exist').toBeDefined();
    if (trail.member_of) {
      expect(trail.member_of, 'Trail 22 should not be in Greenbelt').not.toMatch(/greenbelt/i);
    }
  });

  it('Sentier des Loups (Gatineau Park, ~45.53°N) is NOT in a Greenbelt network', () => {
    const trail = entries.find(e => e.name === 'Sentier des Loups');
    expect(trail, 'Sentier des Loups should exist').toBeDefined();
    if (trail.member_of) {
      expect(trail.member_of).not.toMatch(/greenbelt/i);
    }
  });

  it('Trail #1 Ridge Road (Gatineau Park, ~45.50°N) is NOT in a Greenbelt network', () => {
    const trail = entries.find(e => e.name === 'Trail #1 Ridge Road');
    if (trail?.member_of) {
      expect(trail.member_of).not.toMatch(/greenbelt/i);
    }
  });

  // -----------------------------------------------------------------------
  // Spot checks: trails in the correct park network
  // -----------------------------------------------------------------------

  it('Trail 50 is in a Gatineau Park network', () => {
    const trail = entries.find(e => e.name === 'Trail 50');
    expect(trail, 'Trail 50 should exist').toBeDefined();
    if (trail.member_of) {
      expect(trail.member_of).toMatch(/gatineau/i);
    }
  });

  it('Trail 24 (Greenbelt, ~45.29°N) is in a Greenbelt network', () => {
    const trail = entries.find(e => e.name === 'Trail 24');
    expect(trail, 'Trail 24 should exist').toBeDefined();
    if (trail.member_of) {
      expect(trail.member_of).toMatch(/greenbelt/i);
    }
  });

  // -----------------------------------------------------------------------
  // No network should mix parks
  // -----------------------------------------------------------------------

  it('no network mixes Gatineau Park and Greenbelt trails', () => {
    const networks = entries.filter(e => e.type === 'network');
    const bySlug = new Map();
    for (const e of entries) {
      // Compute slug roughly
      const slug = e.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
      bySlug.set(slug, e);
    }

    for (const network of networks) {
      if (!network.members || network.members.length === 0) continue;

      const memberLats = network.members
        .map(slug => bySlug.get(slug))
        .filter(Boolean)
        .map(e => e.anchors?.[0]?.[1])
        .filter(Boolean);

      if (memberLats.length < 2) continue;

      const hasGreenbeltArea = memberLats.some(lat => lat < 45.40);
      const hasGatineauArea = memberLats.some(lat => lat > 45.50);

      if (hasGreenbeltArea && hasGatineauArea) {
        // This network spans both parks — that's the bug
        const greenbeltMembers = network.members.filter(slug => {
          const e = bySlug.get(slug);
          return e?.anchors?.[0]?.[1] < 45.40;
        });
        const gatineauMembers = network.members.filter(slug => {
          const e = bySlug.get(slug);
          return e?.anchors?.[0]?.[1] > 45.45;
        });

        expect.fail(
          `Network "${network.name}" mixes parks:\n` +
          `  Greenbelt members (lat < 45.40): ${greenbeltMembers.join(', ')}\n` +
          `  Gatineau members (lat > 45.50): ${gatineauMembers.join(', ')}`
        );
      }
    }
  });

  // -----------------------------------------------------------------------
  // La Boucle MTB network: all trails near 45.51°N,-75.75°W should be
  // in ONE network, not split into la-boucle/major/molo/extreme
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // No network should reference itself or other networks as members
  // -----------------------------------------------------------------------

  it('no network has itself as a member (self-reference)', () => {
    const networks = entries.filter(e => e.type === 'network');
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
    const networks = entries.filter(e => e.type === 'network');
    const networkSlugs = new Set();
    for (const net of networks) {
      const slug = net.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
      networkSlugs.add(slug);
    }

    for (const net of networks) {
      for (const memberSlug of net.members || []) {
        const memberEntry = entries.find(e => {
          const s = e.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
          return s === memberSlug;
        });
        if (memberEntry?.type === 'network') {
          expect.fail(`Network "${net.name}" has network "${memberEntry.name}" (${memberSlug}) as a member`);
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // Ottawa River Pathway should be its own network with east/west/TCT as members
  // -----------------------------------------------------------------------

  it('Ottawa River Pathway is a network with east/west/TCT members', () => {
    const orpNetwork = entries.find(e => e.type === 'network' && e.name?.includes('Ottawa River Pathway'));
    expect(orpNetwork, 'Should have an Ottawa River Pathway network').toBeDefined();
    expect(orpNetwork.members?.length).toBeGreaterThanOrEqual(2);
  });

  // -----------------------------------------------------------------------
  // Ottawa River Pathway: named ways already in a relation must NOT create
  // separate ghost entries. The pipeline discovers ways named "Ottawa River
  // Pathway" that are members of the east/west/TCT relations AND ~11 orphan
  // ways that share nodes with those relations. None of these should become
  // standalone entries — the relation entries already cover them.
  // -----------------------------------------------------------------------

  it('no ghost entries duplicate Ottawa River Pathway relations', () => {
    // The network entry and the relation-based members (east/west/TCT) are correct.
    // But the pipeline also discovers named ways "Ottawa River Pathway" and creates
    // entries like ottawa-river-pathway-2, ottawa-river-pathway-1. These are ghost
    // entries whose geometry overlaps with the relation-based entries.
    const orpGhosts = entries.filter(e =>
      e.name === 'Ottawa River Pathway' &&
      e.type !== 'network' &&
      !e.osm_relations?.length
    );
    expect(
      orpGhosts.length,
      `Found ${orpGhosts.length} ghost ORP entries (way-based duplicates of relation members): ` +
      orpGhosts.map(e => JSON.stringify({ osm_names: e.osm_names, anchors: e.anchors?.[0] })).join(', ')
    ).toBe(0);
  });

  it('Ottawa River Pathway network only has relation-based members (no ghost slugs)', () => {
    const orpNetwork = entries.find(e => e.type === 'network' && e.name === 'Ottawa River Pathway');
    expect(orpNetwork, 'ORP network should exist').toBeDefined();
    // Members should be named segments (east/west/TCT) + markdown overrides,
    // NOT numbered ghost slugs from duplicate named way discovery
    for (const memberSlug of orpNetwork.members || []) {
      expect(
        memberSlug,
        `Network member "${memberSlug}" looks like a ghost slug from duplicate way discovery`
      ).not.toMatch(/^ottawa-river-pathway-\d+$/);
    }
  });

  // -----------------------------------------------------------------------
  // Same trail name used in different parks: "Trail 26" exists in both
  // the Greenbelt (~45.30°N) and Gatineau Park (~45.46°N). They must
  // NOT be merged into one entry — they're different trails.
  // -----------------------------------------------------------------------

  it('Trail 26 exists as separate entries for Greenbelt and Gatineau Park', () => {
    // "Trail 26" is used in both the Greenbelt (~45.30N) and Gatineau Park (~45.46N).
    // They must be separate entries, not one entry with mixed geometry.
    const trail26entries = entries.filter(e => e.name === 'Trail 26');
    expect(trail26entries.length, 'Should have 2+ Trail 26 entries (one per park)').toBeGreaterThanOrEqual(2);

    // Each entry's anchors should be in ONE park, not spanning both
    for (const entry of trail26entries) {
      const lats = (entry.anchors || []).map(a => a[1]);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const span = (maxLat - minLat) * 111; // rough km
      expect(span, `Trail 26 entry spans ${span.toFixed(0)}km — should be <10km (one park)`).toBeLessThan(10);
    }
  });

  it('Trail 20 exists as separate entries for Greenbelt and Gatineau Park', () => {
    // Same issue: "Trail 20" used in both parks
    const trail20entries = entries.filter(e => e.name === 'Trail 20');
    expect(trail20entries.length, 'Should have 2+ Trail 20 entries (one per park)').toBeGreaterThanOrEqual(2);

    for (const entry of trail20entries) {
      const lats = (entry.anchors || []).map(a => a[1]);
      const minLat = Math.min(...lats);
      const maxLat = Math.max(...lats);
      const span = (maxLat - minLat) * 111;
      expect(span, `Trail 20 entry spans ${span.toFixed(0)}km — should be <10km (one park)`).toBeLessThan(10);
    }
  });

  // -----------------------------------------------------------------------
  // Park overrides type: Watts Creek (paved) is in the Greenbelt park,
  // so it should be in the Greenbelt network even though the Greenbelt
  // trails are unpaved.
  // -----------------------------------------------------------------------

  it('Watts Creek Pathway (paved) is in the Greenbelt network (same park)', () => {
    const watts = entries.find(e => e.name === 'Watts Creek Pathway');
    expect(watts, 'Watts Creek Pathway should exist').toBeDefined();
    expect(watts.member_of, 'Watts Creek should be in a network').toBeDefined();
    expect(watts.member_of).toMatch(/greenbelt/i);
  });

  // -----------------------------------------------------------------------
  // Relation-based entries must survive named-way filtering.
  // The pipeline filters named ways whose names match a relation's base name
  // (to prevent ghost entries). But the relation entries themselves must still
  // exist and retain their member_of assignments.
  // -----------------------------------------------------------------------

  it('Rideau River Eastern Pathway exists (trace where it gets lost)', () => {
    // Relation 7369735 is the main Rideau River Eastern Pathway cycling route.
    // Relation 10990512 is its parent superroute.
    // Both are discovered as cycling relations in step 1.
    const byRel7369735 = entries.find(e => e.osm_relations?.includes(7369735));
    const byRel10990512 = entries.find(e => e.osm_relations?.includes(10990512));
    const byName = entries.filter(e => e.name === 'Rideau River Eastern Pathway');
    const byNameIncludes = entries.filter(e => e.name?.includes('Rideau River Eastern'));
    // Check if a network absorbed relation 7369735
    const networkWithRel = entries.find(e =>
      e.type === 'network' && e.osm_relations?.includes(7369735)
    );
    // Check ALL networks for these relation IDs
    const netsWithEither = entries.filter(e =>
      e.type === 'network' && (e.osm_relations?.includes(7369735) || e.osm_relations?.includes(10990512))
    );
    // Check if the entry was absorbed into a group or renamed
    const allWithRideau = entries.filter(e =>
      e.osm_relations?.includes(7369735) || e.osm_relations?.includes(10990512) ||
      e._member_relations?.some(r => r.id === 7369735 || r.id === 10990512)
    );
    // Check the "same-named entries absorbed into networks" logic:
    // is there a NETWORK named "Rideau River Eastern Pathway"?
    const rreNetwork = entries.find(e =>
      e.type === 'network' && e.name?.toLowerCase().includes('rideau river eastern')
    );
    expect(byName.length,
      `Exact name: ${byName.length}. ` +
      `Partial: ${byNameIncludes.map(e => `"${e.name}" (type=${e.type||'path'}, rels=${e.osm_relations})`).join('; ')}. ` +
      `Rel 7369735 on: ${byRel7369735 ? `"${byRel7369735.name}" (type=${byRel7369735.type||'path'})` : 'NOWHERE'}. ` +
      `Rel 10990512 on: ${byRel10990512 ? `"${byRel10990512.name}" (type=${byRel10990512.type||'path'})` : 'NOWHERE'}. ` +
      `Any entry with either rel: ${allWithRideau.map(e => `"${e.name}" type=${e.type||'path'} rels=${e.osm_relations}`).join('; ') || 'NONE'}. ` +
      `RRE network exists: ${rreNetwork ? `"${rreNetwork.name}" rels=${rreNetwork.osm_relations}` : 'NO'}. ` +
      `Total entries named "Rideau River Eastern Pathway" (any type): ${entries.filter(e => e.name === 'Rideau River Eastern Pathway').length}`
    ).toBeGreaterThan(0);

    // Separate assertion: the 2 path entries (7369735 and 10990512) should
    // NOT both exist as buildEntries creates both from osmRelations.
    // If one has type=superroute, step 8a's same-name dedup would eat the other.
    // Let's just verify what we have.
  });

  it('relation 7369735 is not swallowed by the same-name dedup (step 8a)', () => {
    // Step 8a removes path entries when a same-named NETWORK exists and
    // has absorbed all of the path's relation IDs. For this to eat
    // "Rideau River Eastern Pathway" (7369735), there must be a network
    // named "Rideau River Eastern Pathway" whose osm_relations includes 7369735.
    //
    // The bug: if 10990512 (a superroute) is discovered as BOTH a cycling
    // relation (step 1, creating a path entry) AND as a superroute (step 5),
    // then discoverNetworks might create a network entry for it that absorbs
    // 7369735. Even if that network is "skipped", the intermediate processing
    // might leave artifacts.
    const networks = entries.filter(e => e.type === 'network');
    const rreNets = networks.filter(n => n.name?.toLowerCase().includes('rideau river eastern'));
    const capitalPathway = networks.find(n => n.name === 'Capital Pathway');

    expect(rreNets.length,
      `Found ${rreNets.length} networks matching "Rideau River Eastern": ` +
      rreNets.map(n => `"${n.name}" rels=${n.osm_relations}`).join('; ')
    ).toBe(0); // Should be 0 — the sub-superroute is skipped

    // Capital Pathway should include rideau-river-eastern-pathway as a member
    expect(capitalPathway, 'Capital Pathway network must exist').toBeDefined();
    expect(capitalPathway.members,
      `Capital Pathway members: ${capitalPathway?.members?.join(', ')}`
    ).toContain('rideau-river-eastern-pathway');
  });

  it('Rideau River Eastern Pathway was not absorbed by auto-grouping', () => {
    // Check if any group entry has "rideau-river-eastern" in grouped_from
    const groupsWithRRE = entries.filter(e =>
      e.grouped_from?.some(slug => slug.includes('rideau-river-eastern'))
    );
    // Also check _absorbedRelations
    const absorbedRRE = entries.filter(e =>
      e._absorbedRelations?.includes(7369735) || e._absorbedRelations?.includes(10990512)
    );
    // Check if the raw entry count before slug computation is right
    const allRRE = entries.filter(e =>
      e.name?.includes('Rideau River Eastern') ||
      e.osm_relations?.includes(7369735) ||
      e.osm_relations?.includes(10990512) ||
      e.osm_names?.some(n => n.includes('Rideau River Eastern'))
    );
    // Force-print what we found regardless of pass/fail
    const traceInfo =
      `Any trace: ${allRRE.map(e => `"${e.name}" type=${e.type||'path'} rels=${e.osm_relations} grouped_from=${e.grouped_from} member_of=${e.member_of}`).join('; ') || 'NONE'}. ` +
      `Groups: ${groupsWithRRE.map(e => `"${e.name}" grouped_from=${e.grouped_from}`).join('; ') || 'NONE'}`;
    // Expect the original entry to exist under its own name (not absorbed into a group)
    const byExactName = allRRE.filter(e => e.name === 'Rideau River Eastern Pathway');
    expect(byExactName.length, traceInfo).toBeGreaterThan(0);
  });

  it('Experimental Farm Pathway relation entry gets highway from relation ways, not named ways', () => {
    // The Experimental Farm Pathway has highway=cycleway ways in its relation.
    // Named ways with the same name might have highway=path. The relation entry
    // should reflect the relation's ways, not be overwritten by named way tags.
    const all = entries.filter(e => e.name === 'Experimental Farm Pathway');
    expect(all.length).toBeGreaterThan(0);
    const entry = all.find(e => e.osm_relations?.length > 0);
    expect(entry, 'Should have a relation-based entry').toBeDefined();
    // Before: highway=cycleway (from relation ways). After our filtering: highway=path
    // (from remaining named ways that are highway=path). This tells us whether
    // the named way merge is overwriting the relation entry's tags.
    expect(entry.highway).toBe('cycleway');
  });

  // -----------------------------------------------------------------------
  // La Boucle MTB network
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Dual network membership: some paths belong to both a park network
  // (NCC Greenbelt) and a superroute network (Capital Pathway). The NCC
  // themselves list these paths on both pages. Each path has one primary
  // network (member_of, determines URL) but should appear in BOTH
  // networks' members arrays.
  // -----------------------------------------------------------------------

  it('Watts Creek Pathway is in both NCC Greenbelt and Capital Pathway', () => {
    const watts = entries.find(e => e.name === 'Watts Creek Pathway' && e.type !== 'network');
    expect(watts, 'Watts Creek Pathway should exist').toBeDefined();
    // Primary: Greenbelt (from park containment)
    expect(watts.member_of).toBe('ncc-greenbelt');

    const greenbelt = entries.find(e => e.type === 'network' && e.name === 'NCC Greenbelt');
    const capitalPathway = entries.find(e => e.type === 'network' && e.name === 'Capital Pathway');
    expect(greenbelt?.members, 'Greenbelt should list Watts Creek').toContain('watts-creek-pathway');
    expect(capitalPathway?.members, 'Capital Pathway should list Watts Creek').toContain('watts-creek-pathway');
  });

  it('Greenbelt Pathway West is in both NCC Greenbelt and Capital Pathway', () => {
    const gpw = entries.find(e => e.name?.includes('Greenbelt Pathway West') && e.type !== 'network');
    expect(gpw, 'Greenbelt Pathway West should exist').toBeDefined();
    expect(gpw.member_of).toBe('ncc-greenbelt');

    const greenbelt = entries.find(e => e.type === 'network' && e.name === 'NCC Greenbelt');
    const capitalPathway = entries.find(e => e.type === 'network' && e.name === 'Capital Pathway');
    expect(greenbelt?.members).toContain(gpw.slug);
    expect(capitalPathway?.members,
      `Capital Pathway members: ${capitalPathway?.members?.join(', ')}`
    ).toContain(gpw.slug);
  });

  it('Greenbelt Pathway East is in both NCC Greenbelt and Capital Pathway', () => {
    const gpe = entries.find(e => e.name === 'Greenbelt Pathway East' && e.type !== 'network');
    expect(gpe, 'Greenbelt Pathway East should exist').toBeDefined();
    expect(gpe.member_of).toBe('ncc-greenbelt');

    const greenbelt = entries.find(e => e.type === 'network' && e.name === 'NCC Greenbelt');
    const capitalPathway = entries.find(e => e.type === 'network' && e.name === 'Capital Pathway');
    expect(greenbelt?.members).toContain(gpe.slug);
    expect(capitalPathway?.members,
      `Capital Pathway members: ${capitalPathway?.members?.join(', ')}`
    ).toContain(gpe.slug);
  });

  // -----------------------------------------------------------------------
  // La Boucle MTB network
  // -----------------------------------------------------------------------

  it('La Boucle area MTB trails are all in one network', () => {
    const trailNames = [
      'La Boucle', 'Extreme', "Rocky's", 'Molo', 'M&M', 'Major',
      'JL Speciale', 'Rentre a Maison', '417', 'La Tour', 'Castor',
      'Houleuse', 'Marais', 'Montee', 'Pont', 'Silly', 'La Crete',
      'Molo 2', 'Molo 3', 'La Pente',
    ];

    const found = trailNames
      .map(name => entries.find(e => e.name === name))
      .filter(Boolean);

    // Should find most of them
    expect(found.length).toBeGreaterThan(15);

    // All trails with member_of should point to the SAME network
    const networks = new Set(found.map(e => e.member_of).filter(Boolean));
    expect(
      networks.size,
      `La Boucle trails split into ${networks.size} networks: ${[...networks].join(', ')}. Should be 1.`
    ).toBe(1);
  });
});
