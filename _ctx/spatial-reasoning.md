---
description: "RULE: never use midpoints, centers, anchors, or bboxes as proxy for real geometry in spatial operations"
type: rule
triggers: [any distance calculation, any proximity check, any containment check, naming unnamed chains, park classification, clustering, splitting same-named ways]
related: [pipeline-overview, naming-unnamed-chains]
---

# Spatial Reasoning — Use Real Geometry

## The Rule

Never use a single point (midpoint, center, anchor, centroid) or a bounding box as a proxy for a path's geometry in any spatial operation. Every time an AI has done this in this project, the result has been wrong.

## What This Means

- **Anchors** in bikepaths.yml are 1-2 bbox corners for Overpass name lookups. They are NOT coordinates.
- **Midpoints** (`geometry[Math.floor(length/2)]`) represent ONE point on a potentially km-long path.
- **Centers** from `out center` are the center of a way's bounding box, not a meaningful location.
- **Bboxes** used as distance proxies ask "are these shapes roughly co-located?" not "do these shapes touch?"

## What To Use Instead

- **Overpass `around.chain`** — `way(id:...)->.chain; (around.chain:500)` searches along the actual way shape.
- **Geometry-to-geometry distance** — `minGeomDist()` from `nearest-park.mjs` computes minimum distance between two sets of real points.
- **Shared OSM nodes** — `clusterByConnectivity` in `cluster-entries.mjs` uses node-level connectivity.
- **Point-in-polygon** — `classifyByPark` in `park-containment.mjs` samples multiple points along the trail.
- **`_ways` field** — transient full geometry available during the build. Use it. It's stripped before YAML output.

## History

This rule exists because of repeated failures:
- Anchor proximity clustering missed trails that share nodes at 0m (led to connectivity-based clustering rewrite)
- Midpoint-based `is_in` missed parks near path endpoints (led to multi-point sampling)
- Midpoint-based nearby-park query couldn't find Ben Franklin Park East (led to `around.chain` queries)
- Center-based park distance ranking picked Roundhay Park over Ben Franklin (led to geometry-to-geometry ranking)
- Midpoint-based way splitting broke OVRT into 4 entries (led to connectivity-based splitting)

See `~/code/bike-app/docs/2026-03-28-ai-referent-drift-postmortem.md` for the full analysis.
