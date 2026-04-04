// detect-mtb.mjs
//
// Label entries as MTB (mountain bike) when they're not road-bike-friendly.
// Three tiers:
//   1. Explicit: has mtb:scale or mtb:scale:imba tag
//   2. Inferred: in a group where any member is explicit MTB → all
//      trail-type members inherit MTB (but not paved members)
//   3. Ambient: highway=path on dirt without bicycle=designated|yes
//      → if you're biking this, you're on a mountain bike
//
// Sets mtb: true on entries. Does not set mtb: false (absence = unknown/not MTB).

const UNPAVED = new Set([
  'ground', 'gravel', 'dirt', 'earth', 'grass', 'sand', 'mud',
  'compacted', 'fine_gravel', 'woodchips', 'unpaved', 'dirt/sand',
]);

function isExplicitMtb(entry) {
  // mtb:scale 0 means "no difficulty, any bike" — NOT an MTB trail.
  // Only scale >= 1 indicates actual MTB terrain.
  const scale = entry['mtb:scale'];
  if (scale != null && scale !== '0' && scale !== 0) return true;
  if (entry['mtb:scale:imba'] != null) return true;
  return false;
}

function isTrailType(entry) {
  if (entry.parallel_to) return false;
  const hw = entry.highway;
  const surface = entry.surface;
  if (hw === 'path' || hw === 'footway') return true;
  if (hw === 'cycleway' && surface && UNPAVED.has(surface)) return true;
  return false;
}

function isDesignatedCycling(entry) {
  // bicycle=designated means a specifically designated cycling route (MUP, bike path).
  // bicycle=yes just means "bikes permitted" — a dirt trail with bicycle=yes is still MTB terrain.
  return entry.bicycle === 'designated';
}

function isPaved(entry) {
  const surface = entry.surface;
  return surface && !UNPAVED.has(surface);
}

/**
 * Label entries as MTB. Mutates entries in place.
 * @param {Array} entries — bikepaths.yml entries
 */
export function detectMtb(entries) {
  // Tier 1: explicit
  for (const entry of entries) {
    if (isExplicitMtb(entry)) entry.mtb = true;
  }

  // Tier 2: inferred from groups
  // If a group has any explicit MTB member, all trail-type members inherit
  const bySlug = new Map();
  for (const entry of entries) {
    // Use a rough slug for lookup — grouped_from references slugs
    const slug = entry.name?.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/[\s-]+/g, '-');
    if (slug) bySlug.set(slug, entry);
  }

  for (const entry of entries) {
    if (!entry.grouped_from) continue;
    // Check if any member is explicit MTB
    const members = entry.grouped_from
      .map(slug => bySlug.get(slug))
      .filter(Boolean);
    const hasExplicitMtb = members.some(m => m.mtb === true);
    if (hasExplicitMtb) {
      // Group itself gets MTB if it's trail-type
      if (isTrailType(entry) || !isPaved(entry)) entry.mtb = true;
      // Trail-type members inherit
      for (const m of members) {
        if (isTrailType(m) && !isPaved(m)) m.mtb = true;
      }
    }
  }

  // Tier 3: ambient — dirt path without cycling designation
  for (const entry of entries) {
    if (entry.mtb) continue; // already labelled
    if (entry.parallel_to) continue; // road infrastructure
    if (isDesignatedCycling(entry)) continue; // proper cycling infra
    if (!isTrailType(entry)) continue; // not a trail
    if (isPaved(entry)) continue; // paved = road bike friendly
    // It's a dirt trail without cycling designation — MTB territory
    entry.mtb = true;
  }
}
