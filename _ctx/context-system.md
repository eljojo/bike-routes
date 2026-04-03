---
description: How the _ctx/ context system works in this repo — mirrors bike-app-astro's pattern
type: guide
triggers: [adding context files, maintaining docs, onboarding to the repo]
---

# Context System

This repo uses the same two-tier context system as `~/code/bike-app-astro`. See `~/code/bike-app-astro/_ctx/context-system.md` for the full loading protocol, type weights, and maintenance rules.

## This Repo's Scope

- **AGENTS.md** — always loaded. Mission, trust-is-binary principle, repo structure, content conventions, pipeline overview.
- **`_ctx/*.md`** — pipeline-specific context. Anchors, clustering, naming, markdown overrides, spatial reasoning rules.
- **`~/code/bike-app-astro/_ctx/bike-paths.md`** — how the Astro app consumes our data. Reference when working on features that affect page generation.

## Cross-Repo References

This repo produces data. The Astro repo renders it. When context spans both:
- Pipeline behavior (how data is produced) → documented here
- Page rendering (how data is consumed) → documented in `~/code/bike-app-astro/_ctx/bike-paths.md`
- The overlay model (how markdown and YML cooperate) → documented in both, from different perspectives
