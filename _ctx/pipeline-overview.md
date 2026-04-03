---
description: "How build-bikepaths.mjs discovers, names, clusters, and networks cycling infrastructure"
type: pattern
triggers: [modifying the pipeline, debugging bikepaths.yml output, adding discovery steps, changing naming logic]
related: [spatial-reasoning, naming-unnamed-chains, markdown-overrides]
---

# Pipeline Overview

`scripts/build-bikepaths.mjs` builds bikepaths.yml from scratch every run. No incremental merge.

## Steps

1. **Discover cycling relations** — `relation["route"="bicycle"]` in bbox
2. **Discover named cycling ways** — cycleways, paths, bike lanes with names. Split same-named ways by connectivity (shared nodes + 100m endpoint snap + 2km bbox merge). Junction trail expansion for non-cycling connectors.
2b. **Discover unnamed parallel lanes** — `highway=cycleway` without names, chained by proximity, matched to nearby roads.
2c. **Discover unnamed cycling chains** — unnamed cycleways/paths >= 1.5km, named from nearby parks/roads using real geometry (`around.chain` + geometry-to-geometry distance).
3. **Build entries** — merge relations, named ways, parallel lanes, manual entries into one entry per path.
4. **Auto-group** — connectivity-based clustering (shared nodes, endpoint proximity). Park containment splits clusters by park. Spur absorption: clusters with only 1 page-worthy member (>= 1km) absorb the rest.
5. **Compute slugs** — centralized disambiguation.
6. **Superroute networks** — promoted sub-superroutes become networks. Top-level superroutes set `super_network` (sorted by scope: ncn < rcn < lcn, most specific wins). Same-named auto-group networks merged into promoted networks.
7. **Route-system networks** — `cycle_network` tag grouping.
8. **Wikidata enrichment** + MTB detection.
9. **Markdown overrides** — `member_of` from markdown frontmatter applied last, before zombie cleanup.
10. **Write YAML** — strip `_ways`, compact anchors, write.

## Key Invariants

- `_ways` is transient — exists in memory during build, stripped before YAML output.
- Anchors are for Overpass name lookups only — never for spatial reasoning.
- bikepaths.yml is the deliverable. Code changes without regenerating data are incomplete.
- The Astro app reads bikepaths.yml + markdown directly. Both must be correct.
