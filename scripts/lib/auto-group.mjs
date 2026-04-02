// auto-group.mjs
import { clusterByConnectivity, pathType } from './cluster-entries.mjs';
import { pickClusterName } from './name-cluster.mjs';

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

/**
 * Auto-group nearby trail segments. Pure function — no file I/O.
 *
 * @param {{ entries: Array, markdownSlugs: Set<string>, queryOverpass: Function }} config
 * @returns {Promise<Array>} — updated entries array (groups replace absorbed members)
 */
export async function autoGroupNearbyPaths({ entries, markdownSlugs, queryOverpass }) {
  // Compute slugs for all entries
  const slugMap = computeSlugs(entries);

  // Identify candidates: have anchors, not claimed by markdown, not network members
  const candidates = entries.filter(entry => {
    const slug = slugMap.get(entry);
    if (markdownSlugs.has(slug)) return false;
    if (!entry.anchors || entry.anchors.length === 0) return false;
    // Network members keep their own pages — don't absorb into auto-generated clusters.
    if (entry.member_of) return false;
    return true;
  });

  if (candidates.length < 2) return entries;

  const clusters = clusterByConnectivity(candidates);
  if (clusters.length === 0) return entries;

  // Name each new cluster (parallel, up to 6 concurrent Overpass queries)
  const newClusters = clusters.filter(c => !c.existingGroup);
  const CONCURRENCY = 6;
  async function nameCluster(cluster) {
    let parkName = null;

    // Only look up containing park/reserve for trail-type clusters
    const types = cluster.members.map(m => pathType(m));
    const trailCount = types.filter(t => t === 'trail').length;
    const isTrailCluster = trailCount > types.length / 2;

    if (isTrailCluster) {
      const { lat, lon } = cluster.centroid;
      try {
        const q = `[out:json][timeout:15];
is_in(${lat},${lon})->.a;
area.a["leisure"~"nature_reserve|park"]["name"]->.b;
area.a["boundary"="protected_area"]["name"]->.c;
area.a["landuse"="forest"]["name"]->.d;
(.b; .c; .d;);
out tags;`;
        const data = await queryOverpass(q);
        if (data.elements.length > 0) {
          const sorted = data.elements.sort((a, b) => {
            const order = { nature_reserve: 0, protected_area: 1, park: 2, forest: 3 };
            const oa = order[a.tags?.leisure] ?? order[a.tags?.boundary] ?? order[a.tags?.landuse] ?? 4;
            const ob = order[b.tags?.leisure] ?? order[b.tags?.boundary] ?? order[b.tags?.landuse] ?? 4;
            return oa - ob;
          });
          parkName = sorted[0].tags?.name || null;
        }
      } catch (err) {
        // Park lookup failed — fall through to other naming strategies
      }
    }

    cluster.resolvedName = pickClusterName(cluster.members, parkName);
  }

  // Worker pool: run up to CONCURRENCY naming tasks at once
  let i = 0;
  async function worker() {
    while (i < newClusters.length) {
      const cluster = newClusters[i++];
      await nameCluster(cluster);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, newClusters.length) }, () => worker()));

  // Park containment merge: clusters with the same resolved name are in the
  // same park/forest/reserve. Merge them into one network. This handles
  // North American parks where trail systems are disconnected islands linked
  // by roads — a spatial fact, not a connectivity fact.
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
      const memberSlugs = cluster.members.map(m => slugMap.get(m));

      const networkEntry = {
        name: cluster.resolvedName,
        type: 'network',
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

      // Assign member_of on each member
      const networkSlug = slugifyBikePathName(cluster.resolvedName);
      for (const m of cluster.members) {
        m.member_of = networkSlug;
      }

      newNetworkEntries.push(networkEntry);
    }
  }

  // Members stay in the array. Network entries are appended.
  const result = [...entries, ...newNetworkEntries];
  return result;
}
