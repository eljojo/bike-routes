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
      group.sort((a, b) => {
        const ka = sortKey(a.entry), kb = sortKey(b.entry);
        return ka.localeCompare(kb);
      });
      for (let i = 0; i < group.length; i++) {
        slugMap.set(group[i].entry, `${base}-${i + 1}`);
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
    if (entry.member_of) return false;
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

  // Build output: create network entries, members KEEP their entries.
  // Networks v2: auto-groups ARE networks. Members keep their own pages
  // and nest under the network URL. No more absorption.
  const allClustersToProcess = [...existingGroupClusters, ...mergedClusters];
  const newNetworkEntries = [];

  for (const cluster of allClustersToProcess) {
    if (cluster.existingGroup) {
      // Extend existing network
      const group = cluster.existingGroup;
      const existingMembers = new Set(group.members || group.grouped_from || []);
      for (const member of cluster.newMembers) {
        const slug = slugMap.get(member);
        if (!existingMembers.has(slug)) {
          if (!group.members) group.members = [...(group.grouped_from || [])];
          group.members.push(slug);
          const memberOsmNames = member.osm_names || [member.name];
          group.osm_names = [...new Set([...(group.osm_names || []), ...memberOsmNames])];
          if (member.osm_relations) {
            group.osm_relations = [...new Set([...(group.osm_relations || []), ...member.osm_relations])];
          }
          group.anchors = bboxAnchors([...(group.anchors || []), ...(member.anchors || [])]);
        }
        member.member_of = slugMap.get(group);
      }
      // Migrate grouped_from → members if not already done
      if (group.grouped_from && !group.members) {
        group.members = group.grouped_from;
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

      // If the network slug collides with a member slug (exact or disambiguated),
      // the member would be filtered as a self-reference. Disambiguate by
      // appending "Trails". Check both exact match and base-slug match
      // (e.g. network "La Boucle" → slug "la-boucle" collides with member
      // slug "la-boucle" which might be disambiguated to "la-boucle-1").
      const memberSlugsRaw = cluster.members
        .filter(m => m.type !== 'network')
        .map(m => slugMap.get(m));
      const hasCollision = memberSlugsRaw.some(s => s === networkSlug) ||
        cluster.members.some(m => slugifyBikePathName(m.name) === networkSlug);
      if (hasCollision) {
        // Use "Trails" for trail-type clusters, "Network" for urban/paved
        const types = cluster.members.map(m => pathType(m));
        const isTrail = types.filter(t => t === 'trail').length > types.length / 2;
        networkName = networkName + (isTrail ? ' Trails' : ' Network');
        networkSlug = slugifyBikePathName(networkName);
      }

      const memberSlugs = memberSlugsRaw.filter(s => s && s !== networkSlug);

      const networkEntry = {
        name: networkName,
        type: 'network',
        _parkName: cluster._parkName || null,
        members: memberSlugs,
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

      // Assign member_of on each member (skip other networks)
      for (const m of cluster.members) {
        if (m.type !== 'network') m.member_of = networkSlug;
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
    // Build lookup: park name → network slug
    const parkToNetworkSlug = new Map();
    for (const cluster of allClustersToProcess) {
      if (cluster._parkName && !cluster.existingGroup) {
        const networkSlug = slugifyBikePathName(cluster.resolvedName);
        parkToNetworkSlug.set(cluster._parkName, networkSlug);
      }
    }

    // Find the network entry for each park
    const networkBySlug = new Map();
    for (const net of newNetworkEntries) {
      const slug = slugifyBikePathName(net.name);
      networkBySlug.set(slug, net);
    }

    let adopted = 0;
    for (const entry of entries) {
      if (entry.member_of) continue; // already in a network
      if (entry.type === 'network') continue;
      // Classify by actual geometry only — never use anchors for spatial
      // reasoning (see AGENTS.md). Entries without _ways can't be classified.
      if (!entry._ways?.length) continue;
      const park = classifyByPark(entry, parks);
      if (!park) continue;

      const networkSlug = parkToNetworkSlug.get(park);
      if (!networkSlug) continue;

      const network = networkBySlug.get(networkSlug);
      if (!network) continue;

      entry.member_of = networkSlug;
      const entrySlug = slugMap.get(entry);
      if (entrySlug && !network.members.includes(entrySlug)) {
        network.members.push(entrySlug);
      }
      adopted++;
    }
    if (adopted > 0) console.log(`  Park adoption: ${adopted} entries added to park networks`);
  }

  const result = [...entries, ...newNetworkEntries];
  return result;
}
