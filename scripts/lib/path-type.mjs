// path-type.mjs
//
// Derives path_type from OSM tags. See _ctx/path-types.md for the spec.
// Called after detectMtb in the pipeline — depends on the mtb boolean.

const UNPAVED = new Set([
  'ground', 'gravel', 'dirt', 'earth', 'grass', 'sand', 'mud',
  'compacted', 'fine_gravel', 'woodchips', 'unpaved', 'dirt/sand',
]);

/**
 * Derive path_type for a bikepaths.yml entry.
 * Returns undefined for network entries (networks aggregate from members).
 * @param {object} entry — a bikepaths.yml entry with OSM-derived fields
 * @returns {string|undefined}
 */
export function derivePathType(entry) {
  if (entry.type === 'network') return undefined;

  // 1. MTB — check mtb boolean (set by detectMtb) and mtb:scale
  if (entry.mtb) return 'mtb-trail';
  const scale = entry['mtb:scale'];
  if (scale != null && scale !== '0' && scale !== 0) return 'mtb-trail';

  // 2-5. Parallel infrastructure (bike lanes alongside roads)
  if (entry.parallel_to) {
    const cw = entry.cycleway;
    if (cw === 'track') return 'separated-lane';
    if (cw === 'shoulder') return 'paved-shoulder';
    return 'bike-lane'; // lane, shared_lane, or unspecified
  }

  // 6. Unpaved surface → trail
  if (entry.surface && UNPAVED.has(entry.surface)) return 'trail';

  // 7. Default — separated multi-use pathway
  return 'mup';
}
