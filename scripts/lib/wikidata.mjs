// scripts/lib/wikidata.mjs
//
// Wikidata enrichment for any bikepaths entry with a wikidata tag.
// Uses the REST API (not SPARQL). Test fixtures are real API responses,
// not invented shapes.

const WIKIDATA_API = 'https://www.wikidata.org/w/rest.php/wikibase/v1/entities/items';

const P_LENGTH = 'P2043';
const P_INCEPTION = 'P571';
const P_WEBSITE = 'P856';

const Q_KILOMETRE = 'Q828224';
const Q_METRE = 'Q11573';

export async function fetchWikidataEntity(qid, fetchFn = fetch) {
  const url = `${WIKIDATA_API}/${qid}`;
  const res = await fetchFn(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'whereto.bike/1.0 (https://ottawabybike.ca)' },
  });
  if (!res.ok) throw new Error(`Wikidata ${qid}: ${res.status}`);
  return res.json();
}

export function extractBikePathMetadata(entity) {
  const meta = {};

  // descriptions are plain strings in the REST API response
  if (entity.descriptions?.en) meta.description_en = entity.descriptions.en;
  if (entity.descriptions?.fr) meta.description_fr = entity.descriptions.fr;

  const lengthClaim = entity.statements?.[P_LENGTH]?.[0];
  if (lengthClaim) {
    // amount is a string like "+220" or "+5.3"
    const amount = parseFloat(lengthClaim.value.content.amount);
    // unit is a full URL like "http://www.wikidata.org/entity/Q828224"
    const unit = lengthClaim.value.content.unit;
    if (unit?.includes(Q_METRE)) meta.length_km = amount / 1000;
    else meta.length_km = amount; // km or unknown — store as-is
  }

  const inceptionClaim = entity.statements?.[P_INCEPTION]?.[0];
  if (inceptionClaim) {
    // time is "+1970-00-00T00:00:00Z", precision 8 = decade, 9 = year
    const time = inceptionClaim.value.content.time;
    const precision = inceptionClaim.value.content.precision;
    // time starts with "+YYYY" or "-YYYY"
    const year = parseInt(time.replace(/^[+-]/, '').slice(0, 4), 10);
    if (precision <= 8) {
      meta.inception = `${Math.floor(year / 10) * 10}s`;
    } else {
      meta.inception = String(year);
    }
  }

  const websiteClaim = entity.statements?.[P_WEBSITE]?.[0];
  if (websiteClaim) {
    // website value is a plain URL string in content
    meta.website = websiteClaim.value.content;
  }

  return meta;
}

export async function enrichWithWikidata(entries, { fetchFn = fetch, concurrency = 4 } = {}) {
  const candidates = entries.filter(e => e.wikidata && !e.wikidata_meta);
  if (candidates.length === 0) return 0;

  let enriched = 0;
  const queue = [...candidates];

  async function worker() {
    let entry;
    while ((entry = queue.shift()) !== undefined) {
      try {
        const entity = await fetchWikidataEntity(entry.wikidata, fetchFn);
        const meta = extractBikePathMetadata(entity);
        // labels are plain strings in the REST API response
        if (!entry.name_fr && entity.labels?.fr) entry.name_fr = entity.labels.fr;
        if (!entry.name_en && entity.labels?.en) entry.name_en = entity.labels.en;
        entry.wikidata_meta = meta;
        enriched++;
      } catch (err) {
        console.error(`  Wikidata ${entry.wikidata}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()));
  return enriched;
}
