# AGENTS.md

This file provides guidance to AI coding agents (e.g. Claude Code) when working with code in this repository.

## What This Is

This is the **data repository** for [Ottawa by Bike](https://ottawabybike.ca) — a curated cycling guide for the National Capital Region. It contains structured cycling content (markdown, GPX tracks, YAML) organized by city. A separate [Astro app](https://github.com/eljojo/bike-app-astro) renders this data into a static website.

The vision is a "Wikipedia of bike routes" — community-driven, openly licensed, forkable.

**Trust is binary.** The app serves real people planning real bike rides. A cyclist looking at "Beechcliffe Park Path" when they're standing on a path that obviously parallels Greenbank Road thinks the app is broken. Not "slightly wrong" — broken. One wrong name and the user questions every other name. `bikepaths.yml` is the deliverable. The code, the tests, the pipeline — all exist to produce correct data. If you changed code but didn't regenerate and commit the data, the work isn't done.

## Repository Structure

```
ottawa/
├── config.yml              # City metadata, CDN URLs, place categories, locales
├── tag-translations.yml    # French labels for English tags
├── redirects.yml           # Global old URL → new slug mappings
├── routes/{slug}/          # Route directories
│   ├── index.md            # English content (frontmatter + body)
│   ├── index.fr.md         # French translation (overrides name/tagline/body)
│   ├── main.gpx            # Primary GPS track
│   ├── media.yml           # Photo/video metadata (blob keys, not files)
│   ├── redirects.yml       # Old ride URLs that map to this route
│   └── variants/           # Alternative GPX tracks
├── places/*.md             # Points of interest (flat files)
├── guides/*.md             # How-to guides (pairs: slug.md + slug.fr.md)
├── events/{year}/*.md      # Calendar events by year
├── organizers/*.md         # Event organizer profiles
└── pages/*.md              # Static pages (pairs: slug.md + slug.fr.md)
```

## Content Conventions

### Routes
- Each route is a **directory** named by its slug (e.g., `routes/aylmer/`)
- `index.md` frontmatter: `name`, `status` (published/draft), `distance_km`, `tags`, `tagline`, `variants`, `created_at`, `updated_at`
- Slug is derived from the directory name — never stored in frontmatter
- Variants list references to GPX files with name, distance_km, and optional strava_url
- `media.yml` is a flat list of photos and videos in camera roll order, each with an immutable `key` (blob key for Cloudflare R2) and a mutable `handle` (human-readable, unique within route)
- Photos have: `type: photo`, `key`, `handle`, `caption`, `score`, `width`, `height`, optional `cover: true`
- Videos have: `type: video`, `key`, `handle`, `title`, `duration`, `width`, `height`, `orientation`

### Translations (i18n)
- Supported locales: `en-CA`, `fr-CA`
- Routes: `index.fr.md` overrides `name`, `tagline`, and body text; can add `slug` field for French URL
- Guides/pages: `{slug}.fr.md` alongside `{slug}.md`
- Places: `name_fr` field in frontmatter (no separate file)
- Tags: `tag-translations.yml` maps English tag → French label
- Only translated fields need to appear in the `.fr.md` file; everything else falls back to English

### Places
- Flat markdown files with frontmatter: `name`, `name_fr`, `category`, `lat`, `lng`, `status`, `address`, `website`, `google_maps_url`
- Categories defined in `config.yml` under `place_categories` (adventure, food, utility groups)

### Events & Organizers
- Events organized by year: `events/2025/event-slug.md`
- Event frontmatter: `name`, `start_date`, `start_time`, `end_date`, `end_time`, `location`, `registration_url`, `organizer`, `poster_key`
- Organizers: `name`, `website`, `instagram`

## Licensing

- Text (markdown): CC BY-SA 4.0
- Route data (GPX): ODbL 1.0
- Media: per-file licensing
- Everything else (YAML, scripts, tooling): Apache 2.0

## Bikepaths Data Conventions

The bikepaths pipeline lives in `~/code/bike-app-astro/scripts/pipeline/` (run via `make bikepaths` from that repo). See `~/code/bike-app-astro/_ctx/pipeline-overview.md` for how it works. This section covers what you need to know when **editing data** in this repo.

### Anchors are NOT coordinates

`anchors` in bikepaths.yml are 1-2 bbox corner points used **only** for geographic scope in Overpass name lookups. They are NOT geometry. They are NOT suitable for:
- Determining if two entries are near each other
- Determining if an entry is "in" a park, neighbourhood, or region
- Any spatial analysis, distance calculation, or geographic reasoning

**If you need to know where something actually is, query Overpass for its real geometry.** The way coordinates from `out geom` queries are the source of truth.

This is not a suggestion. Every time an AI has used anchors for spatial reasoning in this project, the result has been wrong. Do not do it.

### bikepaths.yml is fully rewritten

bikepaths.yml is regenerated from scratch on every pipeline run. Never hand-edit it — your changes will be overwritten. Manual additions (out-of-bounds relations not discoverable by bbox queries) go in `manual-entries.yml`. Human overrides (names, descriptions, operator labels) go in the markdown layer (`bike-paths/*.md`).

### Markdown is the human override layer

`ottawa/bike-paths/*.md` files override and extend what the algorithm produces:
- `name` in frontmatter overrides the auto-generated group name
- `includes` lists bikepaths.yml slugs that should be shown on this page — use this to merge things the algorithm split (e.g. disconnected trail clusters that are conceptually one system)
- `member_of` assigns an entry to a network the algorithm didn't discover
- `path_type` overrides the computed infrastructure type
- `type` overrides the computed entry type (destination/infrastructure/connector)
- The algorithm does 80% of the work. Humans do the 20% via markdown.
- `includes` assignments must be verified geographically by querying Overpass for real way coordinates — never by name-matching, never by using anchors from bikepaths.yml

## Relationship to the Astro App

The Astro app references this repo via `CONTENT_DIR` env var (defaults to `../bike-routes`). The `CITY` env var selects which city folder to build (defaults to `ottawa`). The app uses custom content loaders to parse routes (GPX + media.yml), computes place-route proximity at build time, and generates static HTML. Changes to this repo trigger rebuilds via GitHub `repository_dispatch`.

GPX files are tracked with Git LFS.

---

## Context

This repo uses a two-tier context system mirroring `~/code/bike-app-astro`. The rules and conventions above are always active. The mandatory files below are read at the start of every session. The triggered files after that are loaded only when their topic matches the task — read the one-line description to decide.

### Always Read

**Read these four files at the start of every session. This is not optional.** They prevent catastrophic mistakes and establish the shared vocabulary used by both repos. Three live in the sibling app repo because the rules are repo-agnostic — there's no point in maintaining two copies.

- [protocol-destructive-actions](~/code/bike-app-astro/_ctx/protocol-destructive-actions.md) — before any git command that modifies the working tree: list files, explain, confirm
- [git-conventions](~/code/bike-app-astro/_ctx/git-conventions.md) — commit granularity, message style, no co-author lines, no auto-commit, no push unless told
- [spatial-reasoning](~/code/bike-app-astro/_ctx/spatial-reasoning.md) — never use midpoints, centers, anchors, or bboxes as a proxy for real geometry
- [domain-model](~/code/bike-app-astro/_ctx/domain-model.md) — the cycling domain: routes, rides, events, places, waypoints, organisers, bike paths

### Triggered — This Repo
- [context-system](_ctx/context-system.md) — how the _ctx/ system works, mirrors bike-app-astro
- [events](_ctx/events.md) — series patterns (recurrence vs schedule), ICS UIDs, deduping auto-imported `slug-2`/`slug-3` files, name hygiene

### Triggered — Sibling App Repo
- `~/code/bike-app-astro/_ctx/event-series.md` — event series schema and consumer code (series-utils, calendar-suggestions dedupe)
- `~/code/bike-app-astro/_ctx/markdown-overrides.md` — how markdown frontmatter is consumed by pipeline and app
- `~/code/bike-app-astro/_ctx/bike-paths.md` — how the Astro app consumes bikepaths.yml and markdown (overlay model, network pages, enrichment)
- `~/code/bike-app-astro/_ctx/pipeline-overview.md` — bikepaths pipeline (moved to monorepo)
- `~/code/bike-app-astro/_ctx/path-types.md` — path_type field spec
- `~/code/bike-app-astro/_ctx/entry-types.md` — entry type field spec
