---
description: "type field in bikepaths.yml — classifies every entry by its role in the user experience"
type: pattern
triggers: [working with entry types, deciding what gets a page, filtering entries for display, scoring bike paths]
related: [pipeline-overview, path-types, markdown-overrides]
---

# Entry Types

Every entry in `bikepaths.yml` has a `type` field that determines what role it plays in the user experience.

## Values

| `type` | Gets a page? | On the map? | Example |
|---|---|---|---|
| `network` | Yes (network page) | Yes (aggregated from members) | Capital Pathway, NCC Greenbelt |
| `destination` | Yes (standalone or member page) | Yes | Sawmill Creek, Trans Orléans, La Boucle |
| `infrastructure` | No | Yes | Bank Street bike lane, Greenbank Road |
| `connector` | No | No | Trilby Court, unnamed park connector |

When absent, the app treats the entry as `infrastructure` (visible on map, no standalone page).

## Derivation

The pipeline computes `type` after `path_type` and MTB detection. Markdown frontmatter can override it. General rules:

- **`network`** — assigned by the pipeline's network discovery step. Not derived here.
- **`destination`** — has `osm_relations` (a named cycling route in OSM), OR `path_type: mtb-trail`, OR MUP/trail above the city's length threshold.
- **`infrastructure`** — `bike-lane` or `paved-shoulder` on a real road, OR short named MUP/trail.
- **`connector`** — tiny bike lane on a minor street, unnamed chain below minimum length.

Length thresholds are configurable per city in `config.yml`.

## Relationship to other fields

- **`path_type`** — what kind of infrastructure (mup, bike-lane, mtb-trail). Informs the `type` derivation but is independent. A `bike-lane` can be `destination` (if overridden by markdown) or `connector`.
- **`member_of`** — network membership. A `destination` can be a member of a network and still get its own page nested under the network URL.
- **`featured`** — markdown-only field for homepage placement. Orthogonal to `type`.

## Usage in code

Code that distinguishes entry kinds checks `type` directly:

```
entry.type === 'network'       // is this a network?
entry.type === 'destination'   // should this get a standalone page?
entry.type !== 'network'       // is this a path (any kind)?
```

The Zod schema validates `type` as an enum: `z.enum(['network', 'destination', 'infrastructure', 'connector']).optional()`.
