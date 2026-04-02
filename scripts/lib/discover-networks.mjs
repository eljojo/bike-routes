// scripts/lib/discover-networks.mjs
//
// Network = OSM superroute grouping multiple route relations.
// Members keep their own pages (additive). This is different from
// grouped_from which absorbs children (reductive).
// Auto-grouping skips entries with member_of to prevent collision.
//
// KEY DESIGN DECISION: Only top-level superroutes become networks.
// Sub-superroutes (a superroute that is itself a child of another
// superroute) are NOT networks — they're paths split into sections.
// Example: Ottawa River Pathway is a sub-superroute of Capital Pathway
// containing east/west/TCT sections. To a cyclist it's one path, not
// a network. Its children get flattened into the parent (Capital Pathway).
// The sub-superroute itself becomes a regular path entry with all its
// child relations merged.
//
// Minimum 2 members to qualify as a network. A superroute with 1
// member in our bbox just means "this path belongs to a larger system"
// — that's metadata on the path, not worth a network page.
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
const MIN_NETWORK_MEMBERS = 2;

export async function discoverNetworks({ bbox, queryOverpass }) {
  // Superroutes have only relation members (no ways), so bbox filtering
  // on the superroute itself returns nothing. Instead: find all bicycle
  // route relations in the bbox, then walk UP to their parent superroutes.
  const q = `[out:json][timeout:120];\nrelation["route"="bicycle"](${bbox});\nrel(br)["type"="superroute"];\nout body;`;
  const data = await queryOverpass(q);
  const allSuperroutes = data.elements.filter(el => el.tags?.type === 'superroute');

  if (allSuperroutes.length === 0) return [];
  console.log(`  Found ${allSuperroutes.length} superroutes in OSM`);

  // Identify which superroutes are children of other superroutes.
  // Sub-superroutes are either:
  //   - Real networks: children have DISTINCT names (Ottawa River Pathway
  //     → east/west/TCT). Promoted to top-level.
  //   - Organizational splits: children share the parent name (Greenbelt
  //     Pathway West → main + Barrhaven). Flattened into parent.
  const allById = new Map(allSuperroutes.map(sr => [sr.id, sr]));
  const childIds = new Set();
  const promotedIds = new Set();
  for (const sr of allSuperroutes) {
    if (!sr.members) continue;
    for (const m of sr.members) {
      if (m.type === 'relation' && allById.has(m.ref)) {
        const child = allById.get(m.ref);
        const parentName = (sr.tags?.name || '').toLowerCase();
        const childName = (child.tags?.name || '').toLowerCase();

        // Expand the sub-superroute to check if it's a real network.
        // ORP has 3 distinct sections (east/west/TCT) → real network.
        // Greenbelt West has 2 variants of the same trail → organizational split.
        // Heuristic: 3+ leaf routes = real network.
        const leaves = await expandSuperroute(child.id, queryOverpass);

        if (leaves.length >= 3) {
          promotedIds.add(m.ref);
          console.log(`  Promoting "${child.tags?.name}" to network (distinct child names)`);
        } else {
          childIds.add(m.ref);
        }
      }
    }
  }
  const topLevel = allSuperroutes.filter(sr => !childIds.has(sr.id) || promotedIds.has(sr.id));
  console.log(`  ${topLevel.length} top-level/promoted, ${childIds.size - promotedIds.size} flattened`);

  const networks = [];
  for (const sr of topLevel) {
    const leaves = await expandSuperroute(sr.id, queryOverpass);

    // Deduplicate by ID (cross-membership)
    const seen = new Set();
    const unique = leaves.filter(l => {
      if (seen.has(l.id)) return false;
      seen.add(l.id);
      return true;
    });

    // Clean up OSM naming quirks — mappers sometimes add "(super)" to
    // distinguish the superroute from the route in their editors.
    let name = sr.tags?.name || `network-${sr.id}`;
    name = name.replace(/\s*\(super\)\s*/i, '');

    // When a leaf route has the same name as the network, it's not a
    // separate path — it IS the network's core route. OSM mappers create
    // a superroute with the same name, then add sibling routes to it.
    // Absorb the same-named child's relation ID into the network entry
    // and remove it from the member list to avoid slug collisions
    // (e.g. "Crosstown Bikeway 2" route vs "Crosstown Bikeway 2" network
    // would both slug to crosstown-bikeway-2, producing ugly -1/-2 suffixes).
    const nameLower = name.toLowerCase();
    const sameNameChildren = unique.filter(l => (l.tags?.name || '').toLowerCase() === nameLower);
    const distinctChildren = unique.filter(l => (l.tags?.name || '').toLowerCase() !== nameLower);

    // Skip networks with too few distinct members — a superroute with
    // only its same-named route and no siblings isn't a network page.
    if (distinctChildren.length < MIN_NETWORK_MEMBERS) {
      console.log(`  Skipping ${name}: only ${distinctChildren.length} distinct member(s)`);
      continue;
    }

    const entry = buildNetworkEntry({
      id: sr.id,
      name,
      tags: sr.tags || {},
      memberRoutes: distinctChildren,
    });

    // Merge absorbed children's relation IDs into the network entry
    for (const child of sameNameChildren) {
      entry.osm_relations.push(child.id);
    }

    // Promoted sub-superroutes become real network entries (type: network
    // with members). Top-level superroutes are super-network attributes.
    if (promotedIds.has(sr.id)) entry._promoted = true;

    networks.push(entry);
    const absorbed = sameNameChildren.length;
    console.log(`  Network: ${entry.name} (${distinctChildren.length} members${absorbed ? `, absorbed ${absorbed} same-named route(s)` : ''})`);
  }

  return networks;
}

/**
 * Discover signed route-system networks from cycle_network + ref tags.
 * Example: Crosstown Bikeways in Ottawa share cycle_network: CA:ON:Ottawa.
 * Routes with the same cycle_network are grouped by ref number.
 * Single-member networks are allowed for signed systems (wayfinding matters).
 */
export async function discoverRouteSystemNetworks({ bbox, queryOverpass }) {
  const q = `[out:json][timeout:120];\nrelation["route"="bicycle"]["cycle_network"](${bbox});\nout tags;`;
  const data = await queryOverpass(q);
  const routes = data.elements.filter(el =>
    el.tags?.cycle_network &&
    (el.tags?.ref || el.tags?.lcn_ref || el.tags?.rcn_ref || el.tags?.ncn_ref)
  );

  if (routes.length === 0) return [];

  // Group by cycle_network
  const byCycleNetwork = new Map();
  for (const r of routes) {
    const cn = r.tags.cycle_network;
    if (!byCycleNetwork.has(cn)) byCycleNetwork.set(cn, []);
    byCycleNetwork.get(cn).push(r);
  }

  const networks = [];
  for (const [cycleNetwork, members] of byCycleNetwork) {
    if (members.length < 2) continue; // need at least 2 routes in the system

    // Build a network name from the cycle_network tag
    // CA:ON:Ottawa → "Ottawa Bikeways", CA:QC:Montreal → "Montréal Bikeways"
    const parts = cycleNetwork.split(':');
    const cityName = parts[parts.length - 1];
    const name = `${cityName} Bikeways`;

    const entry = {
      name,
      type: 'network',
      _member_relations: members.map(r => r.id),
      cycle_network: cycleNetwork,
    };

    networks.push(entry);
    console.log(`  Route system: ${name} (${members.length} routes, cycle_network: ${cycleNetwork})`);
  }

  return networks;
}
