import { describe, it, expect } from 'vitest';
import { selectBestRoad } from './select-best-road.mjs';

describe('selectBestRoad', () => {
  // Bug: Irwin Miller Street (residential) was picked over McArthur Avenue
  // (secondary) for the bike lane at their intersection (~45.4319, -75.6526).
  // The old code used `out tags 1` which returned whichever road Overpass
  // happened to list first. The fix: rank by road classification.
  it('prefers McArthur Avenue (secondary) over Irwin Miller Street (residential)', () => {
    const queryPoint = { lat: 45.4319, lon: -75.6526 };

    // Simulate two roads returned by `around:30` — Irwin Miller is closer
    // to the midpoint but McArthur is the higher-class road.
    const roads = [
      {
        tags: { highway: 'residential', name: 'Irwin Miller Street' },
        center: { lat: 45.43195, lon: -75.65258 },
      },
      {
        tags: { highway: 'secondary', name: 'McArthur Avenue' },
        center: { lat: 45.43210, lon: -75.65240 },
      },
    ];

    const best = selectBestRoad(roads, queryPoint);
    expect(best).not.toBeNull();
    expect(best.name).toBe('McArthur Avenue');
    expect(best.highway).toBe('secondary');
  });

  it('returns the only road when there is just one candidate', () => {
    const queryPoint = { lat: 45.43, lon: -75.65 };
    const roads = [
      { tags: { highway: 'residential', name: 'Some Street' }, center: { lat: 45.43, lon: -75.65 } },
    ];
    const best = selectBestRoad(roads, queryPoint);
    expect(best.name).toBe('Some Street');
  });

  it('returns null for empty input', () => {
    expect(selectBestRoad([], { lat: 45, lon: -75 })).toBeNull();
    expect(selectBestRoad(null, { lat: 45, lon: -75 })).toBeNull();
  });

  it('breaks ties within same road class by distance', () => {
    const queryPoint = { lat: 45.43, lon: -75.65 };
    const roads = [
      {
        tags: { highway: 'tertiary', name: 'Far Street' },
        center: { lat: 45.435, lon: -75.645 }, // farther
      },
      {
        tags: { highway: 'tertiary', name: 'Near Street' },
        center: { lat: 45.4301, lon: -75.6501 }, // closer
      },
    ];
    const best = selectBestRoad(roads, queryPoint);
    expect(best.name).toBe('Near Street');
  });

  it('skips roads without a name', () => {
    const queryPoint = { lat: 45.43, lon: -75.65 };
    const roads = [
      { tags: { highway: 'primary' }, center: { lat: 45.43, lon: -75.65 } },
      { tags: { highway: 'residential', name: 'Named Street' }, center: { lat: 45.43, lon: -75.65 } },
    ];
    const best = selectBestRoad(roads, queryPoint);
    expect(best.name).toBe('Named Street');
  });
});
