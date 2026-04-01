import { haversineM } from './geo.mjs';

export function resampleByDistance(points, intervalM = 100) {
  if (points.length < 2) return [...points];

  const result = [points[0]];
  let accumulated = 0;

  for (let i = 1; i < points.length; i++) {
    const d = haversineM(
      [points[i - 1][1], points[i - 1][0]],
      [points[i][1], points[i][0]],
    );
    if (d === 0) continue;
    accumulated += d;
    while (accumulated >= intervalM) {
      accumulated -= intervalM;
      const frac = 1 - (accumulated / d);
      const lat = points[i - 1][0] + frac * (points[i][0] - points[i - 1][0]);
      const lng = points[i - 1][1] + frac * (points[i][1] - points[i - 1][1]);
      result.push([lat, lng]);
    }
  }

  const last = points[points.length - 1];
  if (result[result.length - 1] !== last) result.push(last);
  return result;
}

export function isOverlapping(candidatePts, existingPts, thresholdM = 30, coverageFrac = 0.5) {
  const candidateSampled = resampleByDistance(candidatePts, 100);
  const existingSampled = resampleByDistance(existingPts, 100);

  const candidateCovered = fractionNear(candidateSampled, existingSampled, thresholdM);
  if (candidateCovered >= coverageFrac) return true;

  const existingCovered = fractionNear(existingSampled, candidateSampled, thresholdM);
  if (existingCovered >= coverageFrac) return true;

  return false;
}

function fractionNear(pointsA, pointsB, thresholdM) {
  if (pointsA.length === 0) return 0;
  let nearCount = 0;
  for (const a of pointsA) {
    for (const b of pointsB) {
      if (haversineM([a[1], a[0]], [b[1], b[0]]) <= thresholdM) {
        nearCount++;
        break;
      }
    }
  }
  return nearCount / pointsA.length;
}
