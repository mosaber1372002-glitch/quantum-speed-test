export const config = { runtime: 'edge' };

/*
 * /api/geo?lat=..&lon=..: reverse geocoding (coordinates -> city / region / country).
 *
 * Runs server-side so the geocoders see this site's address rather than the visitor's. Coordinates are rounded to
 * 2 decimals (~1 km) before use, which is enough for a city and avoids street-level data; nothing is logged or stored.
 *
 * Two independent OpenStreetMap-based geocoders are tried in order, so one outage or rate limit does not lose the
 * place name:
 *   1. Nominatim (nominatim.openstreetmap.org)  usage policy: identify the app, low volume
 *   2. Photon    (photon.komoot.io)             keyless public instance, fair use
 * The answer says which one produced it and, when everything fails, what each one reported (`tried`).
 * Results are cached per ~1 km tile.
 */

const cache = new Map(); // "lat,lon" -> { t, data }
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;
const UA = 'QuantumSpeedTest/1.0 (reverse geocoding, city level)';
const out = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=3600' }
});
const s = v => (typeof v === 'string' && v.trim() ? v.trim() : null);

async function getJSON(url) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { accept: 'application/json', 'user-agent': UA } });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}
const why = e => e?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS} ms` : e?.status === 429 ? 'rate limited (HTTP 429)' : e?.status ? 'HTTP ' + e.status
  : e instanceof SyntaxError ? 'response was not valid JSON' : String(e?.message || e).slice(0, 100) + (e?.cause?.code ? ` (${e.cause.code})` : '');

const providers = [
  { name: 'nominatim', async get(lat, lon) {
    const d = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1&accept-language=en&lat=${lat}&lon=${lon}`);
    const a = d.address || {};
    return { city: s(a.city || a.town || a.village || a.municipality || a.suburb || a.county), region: s(a.state || a.region || a.state_district || a.province),
      country: s(a.country), cc: a.country_code ? String(a.country_code).toUpperCase() : null };
  } },
  { name: 'photon', async get(lat, lon) {
    const d = await getJSON(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=en`);
    const p = d.features?.[0]?.properties || {};
    return { city: s(p.city) || (p.type === 'city' ? s(p.name) : null), region: s(p.state) || s(p.county), country: s(p.country), cc: p.countrycode ? String(p.countrycode).toUpperCase() : null };
  } }
];

export default async function handler(req) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get('lat')), lon = Number(u.searchParams.get('lon'));
  if (!u.searchParams.get('lat') || !u.searchParams.get('lon') || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180)) return out({ error: 'bad-coordinates' }, 400);
  const rl = lat.toFixed(2), ro = lon.toFixed(2), key = rl + ',' + ro;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return out({ ...hit.data, cached: true });

  const tried = [];
  for (const p of providers) {
    const t0 = Date.now();
    try {
      const r = await p.get(rl, ro);
      if (!r.country && !r.city) { tried.push({ name: p.name, status: 'empty', ms: Date.now() - t0, detail: 'no place found at these coordinates' }); continue; }
      const data = { ...r, provider: p.name, tried: [...tried, { name: p.name, status: 'ok', ms: Date.now() - t0 }] };
      if (cache.size > 500) cache.clear();
      cache.set(key, { t: Date.now(), data });
      return out(data);
    } catch (e) { tried.push({ name: p.name, status: 'failed', ms: Date.now() - t0, detail: why(e) }); }
  }
  const allEmpty = tried.every(t => t.status === 'empty');
  return out({ error: allEmpty ? 'no-result' : 'geocoder-unavailable', tried }, allEmpty ? 404 : 502);
}
