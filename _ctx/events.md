---
description: Event data conventions — series patterns, ICS UIDs, deduping auto-imported duplicates, name hygiene
type: knowledge
triggers: [editing event files, merging duplicate events, adding a series, importing from Tockify/ICS, slug-2/slug-3 files, ics_uid handling]
related: [context-system]
---

# Events

Events live in `ottawa/events/{year}/`. Either a flat `slug.md` or a directory `slug/index.md` (when posters/extra files belong to one event). Schema and consumer code live in `~/code/bike-app-astro` — see [event-series](~/code/bike-app-astro/_ctx/event-series.md) for the canonical schema reference.

## Two Series Patterns

Repeating events use the `series:` frontmatter block. The schema accepts either pattern, never both at once.

**Pattern 1 — `recurrence`.** Use when the cadence is mechanical (every Thursday, every other Tuesday) over a clear season window.

```yaml
series:
  recurrence: weekly        # or biweekly
  recurrence_day: thursday
  season_start: "2026-05-07"
  season_end:   "2026-09-03"
  skip_dates: ["2026-07-09"]
  overrides:                # date-specific overrides into the generated cadence
    - date: "2026-05-07"
      uid: https://obcrides.ca/events/3346
      registration_url: https://obcrides.ca/events/3346
    - date: "2026-06-25"
      cancelled: true
```

**Pattern 2 — `schedule`.** Use when the dates are an explicit list with no fixed cadence (cohorts, tour weeks, three Bushtukah workshops). Prefer this over recurrence whenever the future dates are *known* rather than *generated* — it's more truthful.

```yaml
series:
  schedule:
    - date: "2026-05-14"
      uid: TKF/.../499/29646570/0/0
      registration_url: https://tockify.com/bushtukah.events/detail/499/...
    - date: "2026-05-28"
      uid: TKF/.../500/29666730/0/0
      registration_url: https://tockify.com/bushtukah.events/detail/500/...
```

Per-occurrence override fields (same shape for `overrides[]` and `schedule[]`): `date`, `location`, `start_time`, `meet_time`, `note`, `cancelled`, `rescheduled_from`, `uid`, `event_url`, `map_url`, `registration_url`. There is no per-occurrence `poster_key` — the top-level poster is shared across all occurrences.

## ICS UID Semantics

- **Top-level `ics_uid`** is the series UID exposed in the calendar feed. By convention, it mirrors the *first* occurrence's `uid` so a single-event import becomes the series anchor when more dates are added later.
- **Per-occurrence `uid`** matches the source VEVENT (Tockify's `TKF/...`, OBC's `https://obcrides.ca/events/N`, or a Google Calendar `@google.com` UID). The Astro app's calendar-suggestions pipeline uses these to dedupe re-imports — keep them stable.

## Auto-Import Duplicates

External calendar imports (Tockify especially) drop new occurrences as `slug-2.md`, `slug-3.md` next to the original `slug.md`. These are almost always the same event recurring, not separate events. When you see `slug-N` files:

1. Check whether they're a true series (same name, location, organizer, recurring date) — merge with Pattern 2.
2. Or whether they're a byte-identical accidental duplicate — `cmp file1 file2` and delete the suffixed one.
3. Or genuinely different events that happened to collide on slug — rename to a more specific slug.

When merging into a series:
- Keep the un-suffixed file as the canonical record.
- Top-level `ics_uid` and `start_date` come from the original (first-occurrence) file.
- Top-level `end_date` becomes the last occurrence date.
- Each old file's `uid` and registration link go into one `schedule[]` entry.
- Tockify URLs are signup pages — store them as `registration_url`, not `event_url`, in each schedule entry.
- Identical-looking poster keys across the duplicates? Keep one. (Same filename in the CDN = same photo.)
- Delete the `-2`, `-3` files.

## Name Hygiene

Tockify imports often produce names with a leading space (e.g. `" Bike Wash and Lube - Bushtukah Orleans"`). Strip leading/trailing whitespace from the `name` field whenever you see it. The leading space is a CSV-export artifact, not intentional.

## Editing an Event That's Already a Series

The Astro app expands `series:` at build time via `expandSeriesOccurrences` in `~/code/bike-app-astro/src/lib/series-utils.ts`. Per-occurrence values fall back to top-level (`location`, `start_time`, `meet_time`) — only set them in `schedule[]` when they actually differ. Don't duplicate the top-level location into every entry "for clarity".
