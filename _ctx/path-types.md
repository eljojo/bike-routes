---
description: "path_type field in bikepaths.yml — classifies cycling infrastructure by safety and bike requirements"
type: pattern
triggers: [working with path_type, adding bike path facts, displaying infrastructure type, filtering paths by type]
related: [pipeline-overview, markdown-overrides]
---

# Path Types

Every non-network entry in `bikepaths.yml` has a `path_type` field that tells a cyclist two things: how safe the ride will be, and what kind of bike they need.

## Values

Listed from most separated to least:

| `path_type` | What a cyclist sees | Typical OSM tags |
|---|---|---|
| `mup` | Multi-use pathway shared with pedestrians, fully separated from cars | `highway=cycleway` or `highway=path` + `bicycle=designated`, no `parallel_to` |
| `separated-lane` | Protected bike lane with physical barrier from traffic | `parallel_to` + `cycleway=track` |
| `bike-lane` | Painted lane on the road, no physical barrier | `parallel_to` + `cycleway=lane` |
| `paved-shoulder` | Road shoulder, rideable but not dedicated | `parallel_to` + `cycleway=shoulder` |
| `mtb-trail` | Mountain bike trail, unpaved and technical | `mtb=true` or `mtb:scale` present |
| `trail` | Unpaved path — gravel, dirt, forest. Not technical MTB | Unpaved surface, `highway=path` or `highway=cycleway` |

## Derivation

The pipeline computes `path_type` from OSM tags. Markdown frontmatter can override it. The derivation order matters — first match wins:

1. `mtb == true` or `mtb:scale` present → `mtb-trail`
2. `parallel_to` + `cycleway == "track"` → `separated-lane`
3. `parallel_to` + `cycleway == "lane"` → `bike-lane`
4. `parallel_to` + `cycleway == "shoulder"` → `paved-shoulder`
5. `parallel_to` (any other) → `bike-lane`
6. Surface is unpaved (`ground`, `gravel`, `dirt`, `earth`, `grass`, `sand`, `mud`, `compacted`, `fine_gravel`, `woodchips`) → `trail`
7. Everything else → `mup`

## Networks

Network entries (`type: network`) do not carry `path_type`. The Astro app aggregates `path_type` from member entries, the same way it aggregates `surface` — with unanimous/partial/mixed consistency.

## Relationship to `mtb`

The `mtb: true` boolean stays in bikepaths.yml because the pipeline uses it for clustering (MTB trails cluster separately from paved paths). For display, the app should use `path_type: mtb-trail` instead of the raw boolean. The `mtb` fact in the facts table is replaced by the `path_type` fact.

## Facts table

`path_type` appears as a fact in the bike path detail view.

- Label key: `paths.label.path_type`
- Value keys: `paths.fact.mup`, `paths.fact.separated_lane`, `paths.fact.bike_lane`, `paths.fact.paved_shoulder`, `paths.fact.mtb_trail`, `paths.fact.trail`
- For networks: aggregated from members with consistency breakdown, same pattern as `surface`
