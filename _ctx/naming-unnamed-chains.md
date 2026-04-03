---
description: "How Step 2c names unnamed cycling chains — is_in, nearby parks/roads, geometry-based ranking"
type: pattern
triggers: [debugging chain names, wrong park name on a path, modifying Step 2c, unnamed chain issues]
related: [spatial-reasoning, pipeline-overview]
---

# Naming Unnamed Chains

Step 2c discovers unnamed cycling ways (no `name` tag, `bicycle=designated|yes`, >= 1.5km when chained). Each chain needs a name. The naming cascade:

## 1. `is_in` containment (multiple sample points)

Sample start, middle, and end of each way in the chain. For each point, query `is_in` for containing parks, nature reserves, forests. If any point is inside a named area, use that name.

This catches trails inside parks. It does NOT use a midpoint — it samples the full chain.

## 2. Nearby park/road (geometry-based, closest wins)

Query parks and roads within 500m/100m of the chain's actual ways using `around.chain` (Overpass way-reference query, NOT a point-based `around`).

Rank candidates by **geometry-to-geometry distance** (`rankByGeomDistance` from `nearest-park.mjs`): minimum distance between any point on the chain and any point on each candidate's polygon. Closest wins. Parks and roads compete on equal footing — a road 20m away beats a park 300m away.

Park polygons sorted largest-first before containment checks — prevents small parks (Bruce Pit) from stealing trails that belong to larger parks (NCC Greenbelt).

## 3. Skip if no name found

Chains that can't be named are dropped (no entry in bikepaths.yml).

## Common Issues

- **Wrong park name**: usually the `is_in` query hit a small park at one sample point. Check which sample points return which parks.
- **Road name instead of park**: the chain runs alongside a road closer than any park. This is correct — the chain parallels the road.
- **Park name collision with network**: an unnamed chain named "Parc de la Gatineau" creates a self-reference with the Parc de la Gatineau network. The park adoption guard in `auto-group.mjs` prevents this.
