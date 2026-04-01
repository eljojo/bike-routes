// name-cluster.mjs

const NUMERIC_ONLY = /^\d+$/;
const RELATION_ID = /^relation-\d+$/;

function isGenericName(name) {
  return NUMERIC_ONLY.test(name) || RELATION_ID.test(name);
}

/**
 * Pick a name for a cluster of trail entries.
 * Fallback: park name → majority operator → longest non-generic member name.
 *
 * @param {Array<{ name: string, operator?: string }>} members
 * @param {string | null} parkName — from Overpass containment query
 * @returns {string}
 */
export function pickClusterName(members, parkName) {
  if (parkName) return parkName;

  // Majority operator
  const opCounts = new Map();
  for (const m of members) {
    if (m.operator) opCounts.set(m.operator, (opCounts.get(m.operator) || 0) + 1);
  }
  if (opCounts.size > 0) {
    const [topOp, topCount] = [...opCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topCount > members.length / 2) return `${topOp} Trails`;
  }

  // Longest non-generic member name
  const candidates = members.filter(m => !isGenericName(m.name));
  if (candidates.length === 0) return members[0].name;
  return candidates.reduce((best, m) => m.name.length > best.name.length ? m : best, candidates[0]).name;
}
