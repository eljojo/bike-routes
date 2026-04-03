---
description: "How markdown frontmatter overrides pipeline-computed values — member_of, operator, name, includes"
type: pattern
triggers: [adding markdown overrides, debugging network membership, fixing wrong member_of, adding a path to a network manually]
related: [pipeline-overview]
---

# Markdown Overrides

Markdown files in `ottawa/bike-paths/*.md` sit between the algorithm and the output. The build pipeline reads frontmatter and applies overrides after all automatic logic but before writing YAML.

## Supported Overrides

| Field | What it does | Example |
|-------|-------------|---------|
| `name` | Overrides the auto-generated entry name | `name: NCC Greenbelt` |
| `operator` | Overrides the OSM operator tag | `operator: Commission de la capitale nationale` |
| `member_of` | Assigns the entry to a network | `member_of: capital-pathway` |
| `includes` | Pulls additional YML entries onto this page | `includes: [trail-a, trail-b]` |

## member_of Override

Added to `buildBikepathsPipeline()` as Step 9. Runs after all automatic network resolution (auto-grouping, superroute discovery, route systems) and before zombie cleanup.

- Parses markdown frontmatter into a `Map<slug, {member_of}>` via `parseMarkdownOverrides()`
- Passed to the pipeline as a parameter (testable without file I/O)
- Validates target network exists (`type: network`) — throws if not
- Removes entry from old network's member list
- Adds entry to new network's member list
- Zombie cleanup runs after, catching networks emptied by overrides

## The 80/20 Rule

The algorithm does 80% of the work. Humans do the 20% via markdown. The overrides exist for cases the algorithm can't handle:
- Trails not in any OSM superroute (Trillium Pathway → Capital Pathway)
- Trails near park boundaries classified wrong
- New infrastructure that OSM hasn't been updated for
- Operator names that need human-readable formatting

## Relationship to the Astro App

The Astro app reads BOTH bikepaths.yml AND markdown directly (`bike-path-entries.server.ts`). For structural fields like `member_of`, the pipeline writes the correct value to bikepaths.yml, and the Astro app reads it from there. For content fields like `name`, `vibe`, `body`, the Astro app reads them from markdown at its own build time.

See `~/code/bike-app-astro/_ctx/bike-paths.md` for the Astro-side overlay model.
