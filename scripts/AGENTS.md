# Route Suggestion Scripts

## Philosophy — "Oasis in the Desert"

The city is a desert of car infrastructure. These scripts find the oases — places where you can safely ride a bike without thinking about cars.

Two questions drive every scoring decision:

1. **"Can I ride here with headphones on?"**
   - **Oasis** (`emplazamiento: parque, mediana, bandejón`): segregated from cars. Cycleways through parks, paths in medians. The hero.
   - **Decent** (`emplazamiento: acera`, or OSM `highway: cycleway`): separated but shared with pedestrians. You're safe but aware.
   - **Exposed** (`emplazamiento: calzada`): on the road with cars. Present because it connects oases, but penalized in scoring.

2. **"Can I stop here?"**
   - Routes that pass cafes, parks, water, bike shops are alive. A 14km corridor with nothing around is dead infrastructure even if it's 100% segregated.
   - Waypoint POIs within 300m of the route are detected and scored. Diversity of stop types matters more than quantity.

This language is shared with the map style generator (`bike-app-astro/scripts/build-map-style.ts`) which uses the same oasis/desert/exposed visual hierarchy.

## Pipeline

```
catastro GeoJSON + Overpass cycling ways
  → segments.mjs (parse, normalize names)
  → axes.mjs (group into corridors)
  → overpass.mjs (fetch POIs + bridges)
  → anchors.mjs (score destinations)
  → trips.mjs (DFS chain search + oasis scoring)
  → curate.mjs (select best N)
  → gpx.mjs + markdown.mjs (generate output)
```

Orchestrated by `suggest-routes.mjs` → `generate-routes.mjs`.

## Key Files

| File | Purpose |
|------|---------|
| `suggest-routes.mjs` | CLI orchestrator. Loads data, runs pipeline, writes proposals JSON |
| `generate-routes.mjs` | Reads proposals, writes routes/places to bike-routes repo |
| `lib/segments.mjs` | Parses catastro + Overpass into normalized segments. Name normalization strips cycling prefixes |
| `lib/axes.mjs` | Groups segments into street-axis corridors via union-find + geometric continuity |
| `lib/overpass.mjs` | Overpass API client with file caching. Fetches POIs, bridges, cycling ways |
| `lib/anchors.mjs` | Scores POIs by destination quality. Clusters into destination zones |
| `lib/trips.mjs` | Core algorithm. DFS chain search, oasis scoring, loop detection, route building |
| `lib/curate.mjs` | Selects best N routes with diversity constraints |
| `lib/gpx.mjs` | GPX generation with segment orientation (reverses backwards segments) |
| `lib/markdown.mjs` | Spanish route descriptions. Consolidated per-axis, archetype-aware |
| `lib/tags.mjs` | Semantic tag assignment (English keys → tag-translations.yml) |
| `lib/geo.mjs` | Geographic utilities (haversine, endpoints, bearing) |
| `lib/slugify.mjs` | URL-safe slug generation |

## Scoring

The composite score in `trips.mjs` combines:
- Infrastructure coverage (0-10)
- Condition score from catastro (0-10)
- Anchor quality at endpoints (0-6)
- Segregation quality — oasis vs exposed riding (-3 to +5)
- Greenery — park path fraction (0-4)
- Waypoint richness — diversity of stops along route (0-6)
- Signature segment — long continuous pathway bonus (0-3)
- Distance sweet spot (0-2)
- Loop shape — oval loops get +5, other loops +2
- Coherence — straight paths and efficient loops (−1 to +2)
- Gap penalty — tiered by gap size (0 to −8)

## Iteration Log

See `bike-app/docs/plans/2026-03-24-route-algorithm-next-iteration.md` for the full history of changes, spot-check findings, and remaining work items.
