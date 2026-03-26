/**
 * Filter OSM ways to cycling infrastructure.
 *
 * When a relation or name query returns both dedicated cycleways AND
 * parallel road lanes (common for avenues with bike paths alongside),
 * prefer the cycleways. Only fall back to roads if no cycleways exist.
 *
 * @param {Array} ways - OSM way elements with tags and geometry
 * @returns {Array} filtered ways — cycleways preferred, roads as fallback
 */
export function filterCyclingWays(ways) {
  if (ways.length === 0) return [];

  // Classify each way
  const cycleways = [];   // highway=cycleway, or bicycle=designated paths
  const bikeLanes = [];   // roads with cycleway tags (lanes on the road)
  const roads = [];       // primary/secondary/tertiary without bike tags

  for (const w of ways) {
    const t = w.tags || {};
    const hw = t.highway || '';

    // Dedicated cycling infrastructure — always keep
    if (hw === 'cycleway') { cycleways.push(w); continue; }
    if ((hw === 'path' || hw === 'footway') && (t.bicycle === 'designated' || t.bicycle === 'yes')) {
      cycleways.push(w); continue;
    }

    // Parks and paths people bike through
    if (t.leisure === 'park' || hw === 'path' || hw === 'pedestrian') {
      cycleways.push(w); continue;
    }

    // Roads with explicit bike lane/track tags
    const hasBikeTags = t.cycleway || t['cycleway:left'] || t['cycleway:right'] || t['cycleway:both'];
    if (hasBikeTags) { bikeLanes.push(w); continue; }

    // Plain roads (no bike infrastructure tags)
    if (['primary', 'secondary', 'tertiary', 'residential', 'living_street'].includes(hw)) {
      roads.push(w); continue;
    }

    // Anything else with bicycle access
    if (t.bicycle === 'designated' || t.bicycle === 'yes') {
      cycleways.push(w); continue;
    }
  }

  // Always include cycleways + roads with bike tags (they complement each other).
  // Only drop plain roads when cycling infrastructure exists.
  const withInfra = [...cycleways, ...bikeLanes];
  if (withInfra.length > 0) return withInfra;
  return roads;
}
