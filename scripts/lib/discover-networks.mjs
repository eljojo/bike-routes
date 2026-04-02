// scripts/lib/discover-networks.mjs
//
// Network = OSM superroute grouping multiple route relations.
// Members keep their own pages (additive). This is different from
// grouped_from which absorbs children (reductive).
// Auto-grouping skips entries with member_of to prevent collision.
//
// Expansion is fully recursive with cycle protection (visited set).
// Member slugs are NOT computed here — that happens in the centralized
// slug pass after all entries are assembled (see build-bikepaths.mjs).
// We store _member_relations (relation IDs) which get resolved to slugs later.

/**
 * Recursively expand a superroute relation to all leaf (non-superroute) routes.
 * Uses cycle protection via a visited set to handle cyclic membership.
 *
 * @param {number} relationId - OSM relation ID of the superroute to expand
 * @param {Function} queryOverpass - async function(query) => { elements }
 * @param {Set} visited - set of already-visited relation IDs (cycle guard)
 * @returns {Promise<Array>} leaf route relation elements
 */
export async function expandSuperroute(relationId, queryOverpass, visited = new Set()) {
  if (visited.has(relationId)) return [];
  visited.add(relationId);

  const q = `[out:json][timeout:60];\nrelation(${relationId});\nrel(r:"");\nout body;`;
  let data;
  try {
    data = await queryOverpass(q);
  } catch (err) {
    console.error(`  Failed to expand superroute ${relationId}: ${err.message}`);
    return [];
  }

  const children = data.elements.filter(el => el.type === 'relation');
  const leaves = [];

  for (const child of children) {
    if (child.tags?.type === 'superroute') {
      leaves.push(...await expandSuperroute(child.id, queryOverpass, visited));
    } else {
      leaves.push(child);
    }
  }

  return leaves;
}

/**
 * Build a bikepaths.yml network entry from superroute metadata.
 *
 * @param {{ id: number, name: string, tags: object, memberRoutes: Array }} opts
 * @returns {object} network entry
 */
export function buildNetworkEntry({ id, name, tags, memberRoutes }) {
  const entry = {
    name,
    type: 'network',
    osm_relations: [id],
    _member_relations: memberRoutes.map(r => r.id),
  };

  if (tags['name:fr']) entry.name_fr = tags['name:fr'];
  if (tags['name:en']) entry.name_en = tags['name:en'];
  if (tags.network) entry.network = tags.network;
  if (tags.operator) entry.operator = tags.operator;
  if (tags.wikidata) entry.wikidata = tags.wikidata;
  if (tags.wikipedia) entry.wikipedia = tags.wikipedia;
  if (tags.ref) entry.ref = tags.ref;
  if (tags.cycle_network) entry.cycle_network = tags.cycle_network;

  return entry;
}

/**
 * Discover cycling network superroutes within a bounding box.
 * Each superroute becomes a network entry with deduplicated leaf members.
 *
 * @param {{ bbox: string, queryOverpass: Function }} opts
 * @param {string} opts.bbox - "south,west,north,east"
 * @param {Function} opts.queryOverpass - async function(query) => { elements }
 * @returns {Promise<Array>} array of network entries
 */
export async function discoverNetworks({ bbox, queryOverpass }) {
  const q = `[out:json][timeout:120];\nrelation["type"="superroute"]["route"="bicycle"](${bbox});\nout body;`;
  const data = await queryOverpass(q);
  const superroutes = data.elements.filter(el => el.tags?.type === 'superroute');

  if (superroutes.length === 0) return [];
  console.log(`  Found ${superroutes.length} cycling network superroutes`);

  const networks = [];
  for (const sr of superroutes) {
    const leaves = await expandSuperroute(sr.id, queryOverpass);

    // Deduplicate by ID (cross-membership)
    const seen = new Set();
    const unique = leaves.filter(l => {
      if (seen.has(l.id)) return false;
      seen.add(l.id);
      return true;
    });

    const entry = buildNetworkEntry({
      id: sr.id,
      name: sr.tags?.name || `network-${sr.id}`,
      tags: sr.tags || {},
      memberRoutes: unique,
    });

    networks.push(entry);
    console.log(`  Network: ${entry.name} (${unique.length} members)`);
  }

  return networks;
}
