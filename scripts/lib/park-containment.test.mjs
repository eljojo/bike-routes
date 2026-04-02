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
