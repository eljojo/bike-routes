// auto-group.mjs
import { clusterByConnectivity, pathType } from './cluster-entries.mjs';
import { pickClusterName } from './name-cluster.mjs';
import { fetchParkPolygons, splitClusterByPark, classifyByPark } from './park-containment.mjs';

// Duplicate of bike-app-astro's slugifyBikePathName — must stay in sync
function slugifyBikePathName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Compute disambiguated slugs for an array of entries (matching Astro's logic).
 * Returns a Map<entry, slug>.
 */
export function computeSlugs(entries) {
  const baseGroups = new Map();
  for (let i = 0; i < entries.length; i++) {
    const base = slugifyBikePathName(entries[i].name);
    if (!baseGroups.has(base)) baseGroups.set(base, []);
    baseGroups.get(base).push({ entry: entries[i], index: i });
  }
  const slugMap = new Map();
  for (const [base, group] of baseGroups) {
    if (group.length === 1) {
      slugMap.set(group[0].entry, base);
    } else {
      // Network entries get the clean slug (no suffix) — they sort first.
      // Among same-type entries, sort by relation ID / anchor / name.
      group.sort((a, b) => {
        const aNet = a.entry.type === 'network' ? 0 : 1;
        const bNet = b.entry.type === 'network' ? 0 : 1;
        if (aNet !== bNet) return aNet - bNet;
        const ka = sortKey(a.entry), kb = sortKey(b.entry);
        return ka.localeCompare(kb);
      });
      // First entry (network if present) gets the clean slug
      slugMap.set(group[0].entry, base);
      for (let i = 1; i < group.length; i++) {
        slugMap.set(group[i].entry, `${base}-${i}`);
      }
    }
  }
  return slugMap;
}

function sortKey(entry) {
  if (entry.osm_relations?.length) return `r${entry.osm_relations[0]}`;
  if (entry.anchors?.length) {
    const a = entry.anchors[0];
    return `a${a[0].toFixed(6)},${a[1].toFixed(6)}`;
  }
  return `n${entry.name}`;
}

/** Collapse an array of anchors to bbox corners for compact YAML storage. */
function bboxAnchors(anchors) {
  const lngs = anchors.map(a => a[0]);
  const lats = anchors.map(a => a[1]);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}

/**
 * Merge tags from multiple entries using most-common-value strategy.
 */
function mergeTags(entries) {
  const tagCounts = {};
  const TAG_KEYS = ['surface', 'highway', 'lit', 'width', 'smoothness', 'operator', 'network'];
  for (const entry of entries) {
    for (const key of TAG_KEYS) {
      if (entry[key]) {
        if (!tagCounts[key]) tagCounts[key] = {};
        tagCounts[key][entry[key]] = (tagCounts[key][entry[key]] || 0) + 1;
      }
    }
  }
  const result = {};
  for (const [key, vals] of Object.entries(tagCounts)) {
    let bestVal = null, bestCount = 0;
    for (const [val, count] of Object.entries(vals)) {
      if (count > bestCount) { bestCount = count; bestVal = val; }
    }
    result[key] = bestVal;
  }
  return result;
}

/** Derive a bbox string from entries' anchors for Overpass queries. */
function deriveBbox(entries) {
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (const e of entries) {
    for (const a of e.anchors || []) {
      const [lng, lat] = a;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      if (lng < west) west = lng;
      if (lng > east) east = lng;
    }
  }
  if (!isFinite(south)) return null;
  return `${south},${west},${north},${east}`;
}

/**
 * Auto-group nearby trail segments. Pure function — no file I/O.
 *
 * @param {{ entries: Array, markdownSlugs: Set<string>, queryOverpass: Function }} config
 * @returns {Promise<Array>} — updated entries array (groups replace absorbed members)
 */
export async function autoGroupNearbyPaths({ entries, markdownSlugs, queryOverpass, bbox }) {
  // Compute slugs for all entries
  const slugMap = computeSlugs(entries);

  // Identify candidates: have anchors, not claimed by markdown, not network members.
  // Exclude parallel_to entries — those are road bike lanes, not trail systems.
  const candidates = entries.filter(entry => {
    const slug = slugMap.get(entry);
    if (markdownSlugs.has(slug)) return false;
    if (!entry.anchors || entry.anchors.length === 0) return false;
    if (entry._networkRef) return false;
    if (entry.parallel_to) return false;
    // Roads with bike lanes are not trail systems — exclude from clustering
    const hw = entry.highway;
    if (hw && ['tertiary', 'secondary', 'primary', 'residential', 'unclassified'].includes(hw)) return false;
    return true;
  });

  if (candidates.length < 2) return entries;

  const clusters = clusterByConnectivity(candidates);
  if (clusters.length === 0) return entries;

  // Fetch park polygons once for per-member classification.
  // Determines which park each trail belongs to using actual geometry,
  // NOT centroids. Fixes the bug where connectivity chains crossing
  // park boundaries caused trails to be assigned to the wrong park.
  if (!bbox) bbox = deriveBbox(candidates);
  let parks = [];
  if (bbox) {
    try {
      parks = await fetchParkPolygons(bbox, queryOverpass);
    } catch (err) {
      console.error(`  Park polygon fetch failed: ${err.message}`);
    }
  }

  // Split clusters that span multiple parks. A connectivity cluster can
  // chain across park boundaries — Trail 26 in the Greenbelt connects
  // through intermediate trails to Trail 27 in Gatineau Park. The
  // connectivity is real but they belong to different networks.
  const newClusters = [];
  for (const cluster of clusters) {
    if (cluster.existingGroup) {
      newClusters.push(cluster);
      continue;
    }

    if (parks.length > 0) {
      const byPark = splitClusterByPark(cluster, parks);
      for (const [parkName, members] of byPark) {
        if (members.length < 2) continue; // too small for a network
        newClusters.push({
          members,
          resolvedName: parkName || pickClusterName(members, null),
          _parkName: parkName,
          existingGroup: null,
          newMembers: members,
        });
      }
    } else {
      // No park data — fall back to old naming
      newClusters.push(cluster);
    }
  }

  // Name clusters that don't have a park name yet (non-park or fallback)
  const CONCURRENCY = 6;
  const unnamed = newClusters.filter(c => !c.resolvedName && !c.existingGroup);
  const queue = [...unnamed];
  async function nameWorker() {
    let cluster;
    while ((cluster = queue.shift()) !== undefined) {
      cluster.resolvedName = pickClusterName(cluster.members, null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => nameWorker()));

  // Park containment merge: clusters in the same park that were split
  // from different connectivity clusters should be one network.
  // (Disconnected trail islands in the same park = one system.)
  const byName = new Map();
  for (const cluster of newClusters) {
    const name = cluster.resolvedName;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(cluster);
  }
  const mergedClusters = [];
  for (const [name, sameNameClusters] of byName) {
    if (sameNameClusters.length === 1) {
      mergedClusters.push(sameNameClusters[0]);
    } else {
      // Merge all same-name clusters into one
      const merged = {
        members: sameNameClusters.flatMap(c => c.members),
        resolvedName: name,
        _parkName: sameNameClusters[0]._parkName, // all share the same park
        existingGroup: null,
        newMembers: sameNameClusters.flatMap(c => c.members),
      };
      mergedClusters.push(merged);
      console.log(`  Merged ${sameNameClusters.length} "${name}" clusters (${merged.members.length} members total)`);
    }
  }
  // Also keep clusters that had existing groups (they weren't in newClusters)
  const existingGroupClusters = clusters.filter(c => c.existingGroup);

  // Spur absorption: if a cluster has only 1 member that qualifies as
  // a standalone page (>= 1km), absorb the rest into it. A network
  // needs at least 2 page-worthy members. Otherwise it's just one trail
  // with minor spurs — not a network.
  const PAGE_MIN_LENGTH_M = 1000;
  function entryLength(entry) {
    if (!entry._ways?.length) return 0;
    let total = 0;
    for (const way of entry._ways) {
      for (let i = 1; i < way.length; i++) {
        const dlat = (way[i].lat - way[i - 1].lat) * 111320;
        const dlng = (way[i].lon - way[i - 1].lon) * 111320 * Math.cos(way[i].lat * Math.PI / 180);
        total += Math.sqrt(dlat * dlat + dlng * dlng);
      }
    }
    return total;
  }

  const absorptionClusters = [];
  const networkClusters = [];
  for (const cluster of [...existingGroupClusters, ...mergedClusters]) {
    if (cluster.existingGroup || cluster.members.length < 2) {
      networkClusters.push(cluster);
      continue;
    }
    const lengths = cluster.members.map(m => entryLength(m));
    const pageWorthy = cluster.members.filter((_, i) => lengths[i] >= PAGE_MIN_LENGTH_M);
    if (pageWorthy.length <= 1 && pageWorthy.length < cluster.members.length) {
      // 0 or 1 page-worthy member — absorb spurs into the longest member
      const longestIdx = lengths.indexOf(Math.max(...lengths));
      const dominant = cluster.members[longestIdx];
      const spurs = cluster.members.filter((_, i) => i !== longestIdx);
      for (const spur of spurs) {
        dominant.osm_names = [...new Set([...(dominant.osm_names || [dominant.name]), ...(spur.osm_names || [spur.name])])];
        if (spur._ways) dominant._ways = [...(dominant._ways || []), ...spur._ways];
        dominant.anchors = bboxAnchors([...(dominant.anchors || []), ...(spur.anchors || [])]);
      }
      absorptionClusters.push({ dominant, spurs });
    } else {
      networkClusters.push(cluster);
    }
  }
  const absorbedEntries = new Set(absorptionClusters.flatMap(c => c.spurs));
  const allClustersToProcess = networkClusters;
  const newNetworkEntries = [];

  for (const cluster of allClustersToProcess) {
    if (cluster.existingGroup) {
      // Extend existing network — resolve grouped_from slugs to entry refs
      const group = cluster.existingGroup;
      if (!group._memberRefs) {
        group._memberRefs = [];
        for (const slug of group.grouped_from || []) {
          const entry = entries.find(e => slugMap.get(e) === slug);
          if (entry) group._memberRefs.push(entry);
        }
      }
      const existingMemberSet = new Set(group._memberRefs);
      for (const member of cluster.newMembers) {
        if (!existingMemberSet.has(member)) {
          group._memberRefs.push(member);
          const memberOsmNames = member.osm_names || [member.name];
          group.osm_names = [...new Set([...(group.osm_names || []), ...memberOsmNames])];
          if (member.osm_relations) {
            group.osm_relations = [...new Set([...(group.osm_relations || []), ...member.osm_relations])];
          }
          group.anchors = bboxAnchors([...(group.anchors || []), ...(member.anchors || [])]);
        }
        member._networkRef = group;
      }
      delete group.grouped_from;
      if (!group.type) group.type = 'network';
    } else {
      // New network from cluster
      const tags = mergeTags(cluster.members);
      const allOsmNames = [...new Set(cluster.members.flatMap(m => m.osm_names || [m.name]))];
      const allOsmRelations = [...new Set(cluster.members.flatMap(m => m.osm_relations || []))];
      let networkName = cluster.resolvedName;
      let networkSlug = slugifyBikePathName(networkName);

      // If the network base slug collides with a member's base slug,
      // the member would be filtered as a self-reference. Disambiguate by
      // appending "Trails" or "Network".
      const hasCollision = cluster.members.some(m =>
        m.type !== 'network' && slugifyBikePathName(m.name) === networkSlug
      );
      if (hasCollision) {
        // Use "Trails" for trail-type clusters, "Network" for urban/paved
        const types = cluster.members.map(m => pathType(m));
        const isTrail = types.filter(t => t === 'trail').length > types.length / 2;
        networkName = networkName + (isTrail ? ' Trails' : ' Network');
        networkSlug = slugifyBikePathName(networkName);
      }

      const memberRefs = cluster.members.filter(m => m.type !== 'network');

      const networkEntry = {
        name: networkName,
        type: 'network',
        _parkName: cluster._parkName || null,
        _memberRefs: memberRefs,
        anchors: bboxAnchors(cluster.members.flatMap(m => m.anchors || [])),
      };

      // Carry _ways from all members for further clustering connectivity
      const allWays = cluster.members.flatMap(m => m._ways || []);
      if (allWays.length > 0) networkEntry._ways = allWays;

      if (allOsmNames.length > 0) networkEntry.osm_names = allOsmNames;
      if (allOsmRelations.length > 0) networkEntry.osm_relations = allOsmRelations;
      for (const [key, val] of Object.entries(tags)) {
        if (val) networkEntry[key] = val;
      }

      // Assign _networkRef on each member (skip other networks)
      for (const m of cluster.members) {
        if (m.type !== 'network') m._networkRef = networkEntry;
      }

      newNetworkEntries.push(networkEntry);
    }
  }

  // Members stay in the array. Network entries are appended.
  // Park adoption: entries not in any network but inside a park that has
  // a network get adopted into it. This handles paved paths inside the
  // Greenbelt, connectors inside Gatineau Park, etc. Park is the stronger
  // signal — if you're in the park, you're in the network regardless of type.
  if (parks.length > 0) {
    // Build lookup: park name → network entry ref
    const parkToNetwork = new Map();
    for (const net of newNetworkEntries) {
      if (net._parkName) parkToNetwork.set(net._parkName, net);
    }

    let adopted = 0;
    for (const entry of entries) {
      if (entry._networkRef) continue; // already in a network
      if (entry.type === 'network') continue;
      // Classify by actual geometry only — never use anchors for spatial
      // reasoning (see AGENTS.md). Entries without _ways can't be classified.
      if (!entry._ways?.length) continue;
      const park = classifyByPark(entry, parks);
      if (!park) continue;

      const network = parkToNetwork.get(park);
      if (!network) continue;

      // Skip if entry has same base slug as network — self-reference guard
      if (slugifyBikePathName(entry.name) === slugifyBikePathName(network.name)) continue;

      entry._networkRef = network;
      if (!network._memberRefs.includes(entry)) {
        network._memberRefs.push(entry);
      }
      adopted++;
    }
    if (adopted > 0) console.log(`  Park adoption: ${adopted} entries added to park networks`);
  }

  const result = [...entries.filter(e => !absorbedEntries.has(e)), ...newNetworkEntries];
  return result;
}
