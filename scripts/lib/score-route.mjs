/**
 * Score a single way's relaxation level (0-5).
 *
 * 5 = full relaxation (park path, dedicated cycleway, physical separation)
 * 4 = comfortable (median path, designated bike path)
 * 3 = aware (sidewalk-level separation, shared path)
 * 2 = alert (quiet street with bike lane)
 * 1 = tense (painted lane on moderate road)
 * 0 = stressed (no bike infrastructure, busy road)
 *
 * Catastro data overrides OSM baseline when available.
 *
 * @param {Object} tags - OSM tags from the way
 * @param {Object} [catastro] - catastro segment data { emplazamiento, quality, ... }
 * @returns {number} 0-5
 */
export function relaxationScore(tags, catastro) {
  // Catastro overrides when available
  if (catastro?.emplazamiento) {
    const emp = catastro.emplazamiento;
    if (emp === 'parque') return 5;
    if (emp === 'bandejón') return 5;
    if (emp === 'mediana') return 4;
    if (emp === 'acera') return 3;
    if (emp === 'calzada') return 0;
  }

  // OSM tag baseline
  const hw = tags.highway || '';
  const cw = tags.cycleway || '';

  // Dedicated cycleway — headphones on
  if (hw === 'cycleway') return 5;
  if (cw === 'track' || cw === 'separate') return 5;

  // Designated bike path
  if (hw === 'path' && tags.bicycle === 'designated') return 4;
  if (hw === 'path' && tags.bicycle === 'yes') return 4;

  // Shared path / footway with bike access
  if (hw === 'footway' && tags.bicycle === 'yes') return 3;
  if (hw === 'path') return 3;

  // Bike lane on quiet street
  if ((hw === 'residential' || hw === 'living_street') && cw) return 2;

  // Bike lane on busier road
  if (cw === 'lane') return 1;
  if (cw === 'shared_lane') return 1;

  // No bike infrastructure
  return 0;
}
