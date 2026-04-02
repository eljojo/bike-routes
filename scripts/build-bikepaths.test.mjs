import { describe, it, expect } from 'vitest';
import { buildBikepathsPipeline } from './build-bikepaths.mjs';

// Fixture: a single unnamed cycleway segment near the McArthur/Irwin Miller
// intersection in Vanier. The road lookup returns both roads — the bug was
// that elements[0] (Irwin Miller, residential) was picked over McArthur
// (secondary) because Overpass doesn't order by road class.

const CYCLEWAY_SEGMENT = {
  type: 'way',
  id: 999001,
  center: { lat: 45.4319, lon: -75.6526 },
  tags: { highway: 'cycleway', surface: 'asphalt', width: '1.5' },
};

const ROADS_NEAR_INTERSECTION = [
  {
    type: 'way', id: 888001,
    tags: { highway: 'residential', name: 'Irwin Miller Street' },
    center: { lat: 45.43195, lon: -75.65258 },
  },
  {
    type: 'way', id: 888002,
    tags: { highway: 'secondary', name: 'McArthur Avenue' },
    center: { lat: 45.43210, lon: -75.65240 },
  },
];

function makeFixtureOverpass(responses) {
  return async (query) => {
    for (const [pattern, data] of responses) {
      if (query.includes(pattern)) return data;
    }
    return { elements: [] };
  };
}

const OTTAWA_ADAPTER = {
  relationNamePattern: '[Pp]athway|[Tt]rail|[Cc]ycl|[Bb]ike|[Ss]entier|MUP|[Pp]iste',
  namedWayQueries: () => [],
  externalData: null,
  parallelLaneFilter: null,
};

describe('buildBikepathsPipeline', () => {
  it('picks McArthur Avenue over Irwin Miller Street for parallel lane', async () => {
    const queryOverpass = makeFixtureOverpass([
      // Relations query — empty
      ['relation["route"="bicycle"]', { elements: [] }],
      // Unnamed cycleways query — our single segment
      ['highway"="cycleway"][!"name"]', { elements: [CYCLEWAY_SEGMENT] }],
      // Road lookup near the chain midpoint — both roads
      ['around:30', { elements: ROADS_NEAR_INTERSECTION }],
    ]);

    const { entries: result } = await buildBikepathsPipeline({
      queryOverpass,
      bbox: '45.15,-76.35,45.65,-75.35',
      adapter: OTTAWA_ADAPTER,
      manualEntries: [],
    });

    const parallel = result.filter(e => e.parallel_to);
    expect(parallel).toHaveLength(1);
    expect(parallel[0].name).toBe('McArthur Avenue');
    expect(parallel[0].parallel_to).toBe('McArthur Avenue');
  });

  it('does not create Irwin Miller Street entry', async () => {
    const queryOverpass = makeFixtureOverpass([
      ['relation["route"="bicycle"]', { elements: [] }],
      ['highway"="cycleway"][!"name"]', { elements: [CYCLEWAY_SEGMENT] }],
      ['around:30', { elements: ROADS_NEAR_INTERSECTION }],
    ]);

    const { entries: result } = await buildBikepathsPipeline({
      queryOverpass,
      bbox: '45.15,-76.35,45.65,-75.35',
      adapter: OTTAWA_ADAPTER,
      manualEntries: [],
    });

    const irwin = result.filter(e => e.name === 'Irwin Miller Street');
    expect(irwin).toHaveLength(0);
  });

  it('merges parallel geometry into existing entry, keeping worse facts', async () => {
    // McArthur Avenue already exists as a named way with highway: secondary.
    // The parallel lane discovery finds a cycleway alongside it.
    // Result: parallel_to gets added, but highway stays "secondary" (worse).
    const existingMcArthur = {
      name: 'McArthur Avenue',
      osm_names: ['McArthur Avenue'],
      highway: 'secondary',
      cycleway: 'lane',
      surface: 'asphalt',
      anchors: [[-75.668, 45.430], [-75.642, 45.432]],
    };

    const queryOverpass = makeFixtureOverpass([
      ['relation["route"="bicycle"]', { elements: [] }],
      ['highway"="cycleway"][!"name"]', { elements: [CYCLEWAY_SEGMENT] }],
      ['around:30', { elements: ROADS_NEAR_INTERSECTION }],
    ]);

    const { entries: result } = await buildBikepathsPipeline({
      queryOverpass,
      bbox: '45.15,-76.35,45.65,-75.35',
      adapter: OTTAWA_ADAPTER,
      manualEntries: [existingMcArthur],
    });

    const mcarthur = result.find(e => e.name === 'McArthur Avenue');
    // parallel_to gets merged in for geometry resolution
    expect(mcarthur.parallel_to).toBe('McArthur Avenue');
    // keeps the road's worse facts, not the cycleway's
    expect(mcarthur.highway).toBe('secondary');
    expect(mcarthur.cycleway).toBe('lane');
    // only one entry, not two
    expect(result.filter(e => e.name === 'McArthur Avenue')).toHaveLength(1);
  });
});
