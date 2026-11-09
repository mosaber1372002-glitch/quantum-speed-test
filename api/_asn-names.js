/*
 * Real company names for AS numbers.
 *
 * Registries and IP databases often describe a network by a technical handle ("TE-AS", "LINKdotNET-AS", "COMCAST-7922"). This module finds the
 * name a person would recognise. Order of authority:
 *   1. _known-asns.js   a list the site owner curates (brand names such as "WE (Telecom Egypt)"). Wins when it has the AS.
 *   2. PeeringDB        free, keyless; operators describe their own network there: business name (`name`, `aka`) and a network type
 *                       ("Cable/DSL/ISP" is a retail provider). Anonymous read access is documented by PeeringDB.
 *   3. RIPEstat         as-overview `holder`, worldwide across all five registries; the layout of that text is only partly documented,
 *                       so it is parsed cautiously and used for a display name only, never as proof of a retail ISP.
 * Both live sources are asked in parallel, each with a short timeout, and the answer is cached per AS number (a day for an answer,
 * five minutes for a failure). Whatever each source answered, or why it failed, is returned in `diag` so it can be shown, not hidden.
 * Nothing here is ever invented: if no source has a usable name, `name` is null and the caller keeps the name the IP databases gave.
 */
import { KNOWN_ASNS } from './_known-asns.js';

const TIMEOUT_MS = 2500, TTL_OK = 24 * 3600e3, TTL_FAIL = 5 * 60e3;
const UA = 'QuantumSpeedTest/1.0 (AS name lookup)';
const cache = new Map();

const clean = s => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : null) || null;
/* "TE-AS", "COMCAST-7922", "LINKdotNET-AS": a registry handle, not a company name */
export const isHandle = n => !!n && !/\s/.test(n) && ((n === n.toUpperCase() && /^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(n)) || /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*-(AS|NET|ASN)\d*$/i.test(n));

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

async function peeringdb(asn) {
  const d = await getJSON(`https://www.peeringdb.com/api/net?asn=${asn}`);
  const n = (Array.isArray(d?.data) ? d.data : []).find(x => x && Number(x.asn) === asn && (!x.status || x.status === 'ok'));
  if (!n) return { status: 'empty', detail: 'this AS number is not listed in PeeringDB' };
  const name = clean(n.name);
  if (!name || name.length > 80) return { status: 'empty', detail: 'PeeringDB entry has no usable name' };
  const types = [n.info_type, ...(Array.isArray(n.info_types) ? n.info_types : [])].filter(Boolean);
  return { status: 'ok', name, aka: clean(n.aka), type: types[0] || null, isIsp: types.includes('Cable/DSL/ISP') };
}

/* holder text is "NAME - Description" (ARIN style) or "NAME Description" (RIPE style). The first word is the handle; what follows is the company. */
export function parseHolder(h) {
  h = clean(h); if (!h) return null;
  let c = null; const i = h.indexOf(' - ');
  if (i > 0) c = h.slice(i + 3);
  else { const m = h.match(/^(\S+)\s+(.+)$/); if (m && isHandle(m[1])) c = m[2]; }
  c = clean(c);
  if (!c || c.length < 3 || c.length > 80 || isHandle(c) || c.toUpperCase() === h.split(' ')[0].toUpperCase()) return null;
  return c;
}
async function ripestat(asn) {
  const d = await getJSON(`https://stat.ripe.net/data/as-overview/data.json?resource=AS${asn}`);
  const holder = clean(d?.data?.holder);
  if (!holder) return { status: 'empty', detail: 'the registry returned no holder name' };
  const name = parseHolder(holder);
  return name ? { status: 'ok', name, raw: holder } : { status: 'empty', detail: `holder "${holder.slice(0, 60)}" holds no company name beyond the handle` };
}

/* -> { name, source, isIsp, aka, type, diag } ; name is null when nothing usable was found */
export async function friendlyAsn(asn) {
  if (asn == null) return null;
  const k = KNOWN_ASNS[asn];
  if (k) return { name: k.name, source: 'known-provider list', isIsp: !k.shared, shared: !!k.shared, diag: { tried: [{ source: 'known-provider list', status: 'ok' }] } };
  const hit = cache.get(asn);
  if (hit && Date.now() - hit.t < (hit.v.name ? TTL_OK : TTL_FAIL)) return { ...hit.v, diag: { ...hit.v.diag, cached: true } };

  const run = async (source, fn) => { const t0 = Date.now(); try { const r = await fn(asn); return { source, ms: Date.now() - t0, ...r }; } catch (e) { return { source, status: 'failed', detail: why(e), ms: Date.now() - t0 }; } };
  const [pdb, ripe] = await Promise.all([run('PeeringDB', peeringdb), run('RIPEstat', ripestat)]);
  const tried = [pdb, ripe].map(r => ({ source: r.source, status: r.status, ms: r.ms, detail: r.detail || null }));
  const win = pdb.status === 'ok' ? pdb : ripe.status === 'ok' ? ripe : null;
  const v = win ? { name: win.name, source: win.source, isIsp: win.source === 'PeeringDB' && !!win.isIsp, aka: win.aka || null, type: win.type || null, diag: { tried } }
    : { name: null, source: null, isIsp: false, diag: { tried } };
  if (cache.size > 500) cache.clear();
  cache.set(asn, { t: Date.now(), v });
  return v;
}
