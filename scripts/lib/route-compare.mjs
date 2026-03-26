/**
 * Route comparison helpers for tests.
 *
 * Standard practice: overlay the generated route on the Google reference,
 * measure the gap at multiple thresholds, and print a diagnostic showing
 * exactly where they diverge.
 *
 * Usage in tests:
 *   import { compareToReference, printComparison } from './route-compare.mjs';
 *   const result = compareToReference(generatedPts, googleRef);
 *   printComparison(result, generatedPts, googleRef);
 *   expect(result.pctAt200).toBeGreaterThanOrEqual(90);
 */

import { haversineM } from './geo.mjs';
import { drawSideBySide } from './ascii-route.mjs';

/**
 * Compare a generated route against a reference polyline.
 * Returns match percentages at multiple thresholds and per-point distances.
 *
 * @param {Array<[number,number]>} generated - [lng, lat] points
 * @param {Array<[number,number]>} reference - [lng, lat] points (Google ref)
 * @returns {Object} comparison result
 */
export function compareToReference(generated, reference) {
  const perPoint = [];

  for (let i = 0; i < reference.length; i++) {
    const ref = reference[i];
    let minDist = Infinity;
    // Sample generated route for speed
    const step = Math.max(1, Math.floor(generated.length / 2000));
    for (let j = 0; j < generated.length; j += step) {
      const d = haversineM(ref, generated[j]);
      if (d < minDist) minDist = d;
    }
    perPoint.push({ idx: i, coord: ref, distM: Math.round(minDist) });
  }

  const thresholds = [50, 100, 200, 500, 1000];
  const pcts = {};
  for (const t of thresholds) {
    const covered = perPoint.filter(p => p.distM <= t).length;
    pcts[`pctAt${t}`] = Math.round(covered / reference.length * 100);
    pcts[`coveredAt${t}`] = covered;
  }

  // Total distances
  let genDist = 0;
  for (let i = 1; i < generated.length; i++) genDist += haversineM(generated[i - 1], generated[i]);
  let refDist = 0;
  for (let i = 1; i < reference.length; i++) refDist += haversineM(reference[i - 1], reference[i]);

  // Start/end offsets
  const startOffset = Math.round(haversineM(generated[0], reference[0]));
  const endOffset = Math.round(haversineM(generated[generated.length - 1], reference[reference.length - 1]));

  // Worst deviations
  const deviations = perPoint.filter(p => p.distM > 200).sort((a, b) => b.distM - a.distM);

  // Longest contiguous uncovered stretch at 200m
  let maxRun = 0, curRun = 0, maxRunStart = 0, curRunStart = 0;
  for (let i = 0; i < perPoint.length; i++) {
    if (perPoint[i].distM > 200) {
      if (curRun === 0) curRunStart = i;
      curRun++;
      if (curRun > maxRun) { maxRun = curRun; maxRunStart = curRunStart; }
    } else { curRun = 0; }
  }

  return {
    ...pcts,
    total: reference.length,
    genDistKm: genDist / 1000,
    refDistKm: refDist / 1000,
    startOffset,
    endOffset,
    deviations,
    longestGap: maxRun > 0 ? {
      points: maxRun,
      startIdx: maxRunStart,
      endIdx: maxRunStart + maxRun - 1,
    } : null,
    perPoint,
  };
}

/**
 * Print a full diagnostic comparison.
 */
export function printComparison(result, generated, reference, name) {
  const lines = [];
  lines.push('');
  lines.push(`=== ${name || 'Route'} vs Google Reference ===`);
  lines.push(`Coverage:  50m=${result.pctAt50}%  100m=${result.pctAt100}%  200m=${result.pctAt200}%  500m=${result.pctAt500}%  1km=${result.pctAt1000}%`);
  lines.push(`Distance:  generated=${result.genDistKm.toFixed(1)}km  reference=${result.refDistKm.toFixed(1)}km  diff=${(result.genDistKm - result.refDistKm).toFixed(1)}km`);
  lines.push(`Offsets:   start=${result.startOffset}m  end=${result.endOffset}m`);

  if (result.deviations.length > 0) {
    lines.push(`Deviations >200m (${result.deviations.length} points):`);
    for (const d of result.deviations.slice(0, 10)) {
      lines.push(`  pt${d.idx}: ${d.distM}m at [${d.coord[0].toFixed(4)}, ${d.coord[1].toFixed(4)}]`);
    }
  }

  if (result.longestGap) {
    const g = result.longestGap;
    lines.push(`Longest uncovered stretch: ${g.points} consecutive points (pt${g.startIdx}-pt${g.endIdx})`);
  }

  console.log(lines.join('\n'));
  console.log('\n' + drawSideBySide(generated, reference, 35));
}
