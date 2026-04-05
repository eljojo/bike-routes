---
description: "How markdown frontmatter overrides pipeline-computed values — two consumers, two purposes"
type: pattern
triggers: [adding markdown overrides, debugging network membership, fixing wrong member_of, adding a path to a network manually, understanding how markdown affects the pipeline vs the app]
related: [pipeline-overview, spatial-reasoning]
---

# Markdown Overrides

Markdown files in `ottawa/bike-paths/*.md` are the human-owned layer. They're how humans tweak what the algorithm produces. They sit between Overpass and the final output.

## Two Consumers, Two Purposes

Markdown is read by two systems with different purposes:

### 1. Pipeline reads markdown → affects bikepaths.yml generation

The build script (`~/code/bike-app-astro/scripts/pipeline/build-bikepaths.mjs`, run via `make bikepaths`) reads markdown frontmatter during pipeline execution. These fields steer the algorithm:

| Field | Effect on pipeline | Example |
|-------|-------------------|---------|
| `member_of` | Entry gets network membership in YAML | `member_of: capital-pathway` |
| `includes` | Claimed entries excluded from auto-grouping | `includes: [trail-a, trail-b]` |
| `operator` | Written to YAML, overrides OSM value | `operator: Commission de la capitale nationale` |
| `path_type` | Overrides computed path_type (see `_ctx/path-types.md`) | `path_type: paved-shoulder` |

The pipeline runs occasionally (when infrastructure changes) and commits the result to bikepaths.yml.

### 2. Astro reads markdown → affects rendering of committed YAML

The Astro app (`bike-path-entries.server.ts`) reads markdown directly at build time. These fields affect display:

| Field | Effect on rendering | Example |
|-------|-------------------|---------|
| `name` | Display name on the page | `name: NCC Greenbelt` |
| `vibe` | Tagline/subtitle | `vibe: "A ring of gravel trail..."` |
| body text | The prose content | (markdown body below frontmatter) |
| `featured` | Homepage placement | `featured: true` |
| `photo_key` | Hero image | `photo_key: abc123` |
| `tags` | Categorization | `tags: [gravel, scenic]` |
| `wikipedia` | External link | `wikipedia: en:Capital Pathway` |

The Astro app runs on every deploy and renders from the committed YAML + markdown.

### Some fields do both

`name` overrides the YAML during pipeline AND overrides display in Astro. `operator` does the same. The pipeline writes the override to YAML; the Astro app reads it from YAML and also from markdown (markdown wins for display).

## The 80/20 Rule

The algorithm does 80% of the work. Humans do the 20% via markdown. The overrides exist for cases the algorithm can't handle:
- Trails not in any OSM superroute (Trillium Pathway → Capital Pathway)
- Trails near park boundaries classified wrong
- New infrastructure that OSM hasn't been updated for
- Operator names that need human-readable formatting
- Disconnected trail clusters that are conceptually one system (`includes`)

## member_of Override (Pipeline Consumer)

Parsed into a `Map<slug, {member_of}>` via `parseMarkdownOverrides()`. Passed to the pipeline as a parameter (testable without file I/O). Applied as Step 9 after all automatic network resolution.

- Validates target network exists (`type: network`) — throws if not
- Removes entry from old network's member list
- Adds entry to new network's member list
- Zombie cleanup runs after, catching networks emptied by overrides

## includes (Both Consumers)

Pipeline: entries listed in `includes` are added to the `markdownSlugs` set. Auto-grouping skips them — they're human-claimed, not available for algorithmic grouping.

Astro: entries listed in `includes` are shown on this markdown file's page, aggregating their geometry, routes, and photos.

## Relationship Between the Two Consumers

```
OSM data (Overpass)
    ↓
Pipeline reads markdown frontmatter (member_of, includes, operator)
    ↓  applies overrides during pipeline execution
    ↓
bikepaths.yml committed with final values
    ↓
Astro reads bikepaths.yml + markdown directly
    ↓  YAML provides structure, markdown provides content
    ↓
Static HTML pages
```

The Astro app doesn't need to know about the pipeline's override logic. It reads the committed YAML (which has correct `member_of`, `operator`, etc.) and the markdown (which has `name`, `vibe`, `body`). Both are inputs to page generation.

See `~/code/bike-app-astro/_ctx/bike-paths.md` for the Astro-side overlay model.
