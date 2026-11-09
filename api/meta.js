export const config = { runtime: 'edge' };
import { friendlyAsn, isHandle } from './_asn-names.js';

/*
 * /api/meta: IP intelligence, resolved server-side.
 *
 *   GET /api/meta            -> the visitor's own address (from Vercel's trusted headers)
 *   GET /api/meta?ip=<addr>  -> a specific public address (the one the speed-test traffic uses,
 *                               which can differ from the one Vercel sees on dual-stack networks)
 *
 * Independent sources are queried in parallel and cross-checked:
 *   maxmind   only with MAXMIND_ACCOUNT_ID + MAXMIND_LICENSE_KEY (paid): the one source with a commercial,
 *             ISP-level `isp` field separate from the ASN owner. Authoritative for the ISP name.
 *   ipapi.is  keyless: classifies the network (isp / hosting / business ...), flags VPN/datacenter, has geolocation
 *   ipwho.is  keyless: dedicated "isp" field (separate from "org"), geolocation
 *   geojs.io  keyless: geolocation + ASN and its registered organisation
 *   ipinfo.io only with IPINFO_TOKEN: geolocation + ASN (paid plans add typed ASN / company / privacy data)
 *
 * Three different things are kept apart and never merged silently:
 *   ISP       the retail provider the customer pays (needs an ISP-level claim, see decide())
 *   operator  the registered owner of the ASN (a fact about the network, not about the customer)
 *   ASN       the autonomous system number
 * When the evidence cannot establish the ISP, `isp` is null and `ispReason` / `ispDetail` say exactly why.
 *
 * Every response carries `diag`: which provider answered, failed (and how), or was skipped (and why), what each
 * said, and how the decision was reached. It contains no credentials: skipped providers only name the missing
 * environment variable.
 *
 * Optional env vars (Vercel project settings or .env.local; never sent to the browser):
 *   IPAPI_IS_KEY, IPINFO_TOKEN, MAXMIND_ACCOUNT_ID + MAXMIND_LICENSE_KEY (+ MAXMIND_SERVICE=city), LOOKUP_TIMEOUT_MS
 *
 * Caching: responses are `no-store` for browsers and CDNs. The only cache is a short per-isolate map keyed by IP
 * address, so a changed address can never be answered with a previous connection's data.
 */

const TIMEOUT_MS = Number((typeof process !== 'undefined' && process.env && process.env.LOOKUP_TIMEOUT_MS) || 3000);
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();   // ip -> { t, data }
const quota = new Map();   // caller ip -> { t, n }  (limits ?ip= lookups for other addresses)
const env = k => (typeof process !== 'undefined' && process.env && process.env[k]) || '';

const reply = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
});
const dec = v => { try { return v ? decodeURIComponent(v) : null; } catch { return v; } };
const str = v => (typeof v === 'string' && v.trim() && !/^unknown$/i.test(v.trim()) ? v.trim() : null);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null));

/* ---- address handling ---- */
function parseIp(raw) {
  const ip = (raw || '').trim();
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return v4.slice(1).every(o => +o <= 255) ? { ip, family: 4 } : null;
  if (/^[0-9a-fA-F:.]{2,45}$/.test(ip) && ip.includes(':') && ip.split(':').length <= 8) return { ip, family: 6 };
  return null;
}
function addressClass(ip, family) {
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'private';
    if (a === 100 && b >= 64 && b <= 127) return 'cgnat'; // shared address space (RFC 6598): operator-side NAT
    return 'public';
  }
  const x = ip.toLowerCase();
  if (x === '::1' || x === '::' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('::ffff:')) return 'private';
  return 'public';
}
function requestAddress(h) {
  return parseIp(h.get('x-vercel-forwarded-for') || h.get('x-real-ip') || (h.get('x-forwarded-for') || '').split(',')[0]);
}

async function getJSON(url, headers) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { accept: 'application/json', ...headers } });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}
const why = e => e?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS} ms`
  : e?.status === 429 ? 'rate limited (HTTP 429)'
  : e?.status ? `HTTP ${e.status}${e.status === 401 || e.status === 403 ? ' (credentials rejected or not permitted)' : ''}`
  : e instanceof SyntaxError ? 'response was not valid JSON'
  : String(e?.message || e).slice(0, 100) + (e?.cause?.code ? ` (${e.cause.code})` : '');

/* ---- providers: each returns one normalised record (or null when the response holds nothing usable) and
        throws on failure; run() turns that into a status for the diagnostics ---- */
const pro = {
  maxmind: {
    name: 'maxmind', need: () => (env('MAXMIND_ACCOUNT_ID') && env('MAXMIND_LICENSE_KEY') ? null : 'MAXMIND_ACCOUNT_ID / MAXMIND_LICENSE_KEY not set'),
    async get(ip) {
      const svc = env('MAXMIND_SERVICE') === 'city' ? 'city' : 'insights';
      const d = await getJSON(`https://geoip.maxmind.com/geoip/v2.1/${svc}/${encodeURIComponent(ip)}`, { authorization: 'Basic ' + btoa(env('MAXMIND_ACCOUNT_ID') + ':' + env('MAXMIND_LICENSE_KEY')) });
      const t = d.traits || {}, l = d.location || {}, ut = str(t.user_type), ct = str(t.connection_type);
      return {
        src: 'maxmind',
        isp: str(t.isp), typed: true, authoritative: true,       // ISP-level field, distinct from the ASN owner
        org: str(t.organization), orgType: null, domain: str(t.domain),
        asn: num(t.autonomous_system_number), asnOrg: str(t.autonomous_system_organization),
        connectionType: ct,
        hosting: t.is_hosting_provider === true || ut === 'hosting' || ut === 'content_delivery_network',
        anonymizer: t.is_anonymous_vpn === true || t.is_public_proxy === true || t.is_tor_exit_node === true || t.is_residential_proxy === true || ut === 'consumer_privacy_network',
        mobile: ct === 'Cellular' || ut === 'cellular',
        geo: { city: str(d.city?.names?.en), region: str(d.subdivisions?.[0]?.names?.en), country: str(d.country?.names?.en), cc: str(d.country?.iso_code), lat: num(l.latitude), lon: num(l.longitude), tz: str(l.time_zone), radiusKm: num(l.accuracy_radius) }
      };
    }
  },
  ipapiis: {
    name: 'ipapi.is', need: () => null,
    async get(ip) {
      const key = env('IPAPI_IS_KEY');
      const d = await getJSON(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}${key ? '&key=' + encodeURIComponent(key) : ''}`);
      if (d && d.error) throw new Error(String(d.error).slice(0, 80));
      if (!d || !d.ip) return null;
      const l = d.location || {};
      return {
        src: 'ipapi.is',
        isp: d.company?.type === 'isp' ? str(d.company?.name) : null, typed: true, // classified as an ISP by the provider itself
        org: str(d.company?.name), orgType: str(d.company?.type), domain: str(d.company?.domain) || str(d.asn?.domain),
        asn: num(d.asn?.asn), asnOrg: str(d.asn?.org), asnType: str(d.asn?.type),
        hosting: d.is_datacenter === true || d.company?.type === 'hosting' || d.asn?.type === 'hosting',
        anonymizer: d.is_vpn === true || d.is_proxy === true || d.is_tor === true,
        mobile: d.is_mobile === true,
        geo: { city: str(l.city), region: str(l.state), country: str(l.country), cc: str(l.country_code), lat: num(l.latitude), lon: num(l.longitude), tz: str(l.timezone) }
      };
    }
  },
  ipwhois: {
    name: 'ipwho.is', need: () => null,
    async get(ip) {
      const d = await getJSON(`https://ipwho.is/${encodeURIComponent(ip)}`);
      if (d && d.success === false) throw new Error(String(d.message || 'lookup refused').slice(0, 80));
      if (!d) return null;
      const c = d.connection || {};
      return {
        src: 'ipwho.is',
        isp: str(c.isp), typed: false,          // dedicated ISP field, kept separate from org
        org: str(c.org), orgType: null, domain: str(c.domain),
        asn: num(c.asn), asnOrg: null,
        geo: { city: str(d.city), region: str(d.region), country: str(d.country), cc: str(d.country_code), lat: num(d.latitude), lon: num(d.longitude), tz: str(d.timezone?.id) }
      };
    }
  },
  geojs: {
    name: 'geojs.io', need: () => null,
    async get(ip) {
      const d = await getJSON(`https://get.geojs.io/v1/ip/geo/${encodeURIComponent(ip)}.json`);
      if (!d || !d.ip) return null;
      const asn = num(d.asn);                      // documented placeholder for "unknown" is 64512
      return {
        src: 'geojs.io', isp: null, typed: false, org: null, orgType: null,
        asn: asn === 64512 ? null : asn, asnOrg: str(d.organization_name),   // the ASN's registered organisation, not an ISP claim
        geo: { city: str(d.city), region: str(d.region), country: str(d.country), cc: str(d.country_code), lat: num(d.latitude), lon: num(d.longitude), tz: str(d.timezone) }
      };
    }
  },
  ipinfo: {
    name: 'ipinfo.io', need: () => (env('IPINFO_TOKEN') ? null : 'IPINFO_TOKEN not set'),
    async get(ip) {
      const d = await getJSON(`https://ipinfo.io/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(env('IPINFO_TOKEN'))}`);
      if (!d || d.bogon || !d.ip) return null;
      const m = /^AS(\d+)\s*(.*)$/i.exec(d.org || '');   // free plan: "AS36992 Etisalat Misr"
      const [lat, lon] = (d.loc || '').split(',').map(Number);
      const asnObj = d.asn && typeof d.asn === 'object' ? d.asn : null; // paid plans
      const asnNum = asnObj ? num(String(asnObj.asn || '').replace(/^AS/i, '')) : (m ? +m[1] : null);
      return {
        src: 'ipinfo.io',
        isp: d.company?.type === 'isp' ? str(d.company?.name) : null, typed: true,
        org: str(d.company?.name), orgType: str(d.company?.type), domain: str(d.company?.domain) || str(asnObj?.domain),
        asn: asnNum, asnOrg: str(asnObj?.name) || (m ? str(m[2]) : null), asnType: str(asnObj?.type),
        hosting: d.privacy?.hosting === true || asnObj?.type === 'hosting',
        anonymizer: d.privacy?.vpn === true || d.privacy?.proxy === true || d.privacy?.tor === true || d.privacy?.relay === true,
        geo: { city: str(d.city), region: str(d.region), country: null, cc: str(d.country), lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null, tz: str(d.timezone) }
      };
    }
  }
};
async function run(p, ip) {
  const miss = p.need();
  if (miss) return { name: p.name, status: 'skipped', detail: miss };
  const t0 = Date.now();
  try {
    const rec = await p.get(ip);
    return rec ? { name: p.name, status: 'ok', ms: Date.now() - t0, rec } : { name: p.name, status: 'empty', ms: Date.now() - t0, detail: 'answered, but with no usable data for this address' };
  } catch (e) { return { name: p.name, status: 'failed', ms: Date.now() - t0, detail: why(e) }; }
}

/* ---- name comparison ---- */
const NOISE = new Set(['inc', 'llc', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company', 'sa', 'ag', 'gmbh', 'plc', 'as', 'ab', 'bv', 'srl', 'pjsc', 'jsc', 'the', 'and', 'of', 'for', 'by']);
// Words shared by unrelated providers; they must not be the only thing two names have in common
const GENERIC = new Set(['telecom', 'telecommunications', 'communications', 'communication', 'network', 'networks', 'internet', 'data', 'services', 'service', 'broadband', 'mobile', 'cable', 'wireless', 'group', 'holding', 'holdings', 'online', 'digital', 'global', 'international', 'national', 'technologies', 'technology', 'systems', 'solutions', 'isp', 'asn', 'as']);
const words = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !NOISE.has(w));
const SLD = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go']);
function regDomain(d) {
  const l = (d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('.').filter(Boolean);
  if (l.length < 2) return null;
  return (l.length > 2 && l[l.length - 1].length === 2 && SLD.has(l[l.length - 2]) ? l.slice(-3) : l.slice(-2)).join('.');
}
/* Do two names plausibly denote the same company? Shared distinctive words ("Etisalat Misr" ~ "ETISALAT MISR",
   "Vodafone Egypt" ~ "Vodafone Data"), or an abbreviation of the other name ("TE" ~ "Telecom Egypt", "BT" ~
   "British Telecommunications"). Words that only name the country or a generic business never count on their own. */
function sameNetwork(a, b, place) {
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return false;
  const core = ws => { const k = ws.filter(w => !GENERIC.has(w) && !place.has(w)); return k.length ? k : ws; };
  const A = core(wa), B = core(wb), SA = new Set(A), SB = new Set(B);
  const inter = A.filter(w => SB.has(w)).length;
  if (inter > 0 && inter / Math.min(SA.size, SB.size) >= 0.5) return true;
  const initials = ws => (ws.length > 1 ? ws.map(w => w[0]).join('') : null);
  const abbr = (x, y) => x.length === 1 && x[0].length >= 2 && x[0].length <= 5 && x[0] === initials(y);
  return abbr(A, wb) || abbr(B, wa);
}
/* a {name, domain} pair can also be linked by a shared registered domain (te.eg ~ te.eg) */
const linked = (x, y, place) => !!(x && y) && ((x.name && y.name && sameNetwork(x.name, y.name, place)) || (x.domain && y.domain && regDomain(x.domain) && regDomain(x.domain) === regDomain(y.domain)));
const pretty = n => (n && n === n.toUpperCase() && /\s/.test(n) && /[A-Z]{3}/.test(n) ? n.toLowerCase().replace(/(^|\s)(\S)/g, (_, s, c) => s + c.toUpperCase()) : n);

/* makers of routers and network equipment are never ISPs (a database can return one through a router's dynamic-DNS name, for example) */
const VENDOR = /\b(tp-?link|huawei|zte|d-?link|netgear|mikrotik|ubiquiti|cisco|juniper|asus(tek)?|linksys|tenda|fortinet|ruckus|arris|technicolor|sagemcom|zyxel|hikvision|dahua)\b/i;
/* ---- decision: who is the retail ISP? Never derived from the ASN owner alone ---- */
function decide(recs, place) {
  const D = { claims: [], clusters: [], rejected: [] };
  const vendorRecs = recs.filter(r => r.isp && (VENDOR.test(r.isp) || VENDOR.test(r.domain || '')));
  D.rejected = vendorRecs.map(r => ({ src: r.src, name: r.isp, why: 'network-equipment manufacturer, not an ISP' }));
  const rej = D.rejected.length ? ` Ignored as equipment makers, not ISPs: ${D.rejected.map(x => `"${x.name}" (${x.src})`).join(', ')}.` : '';
  const names = recs.map(r => `${r.src}: ${r.isp ? 'ISP "' + r.isp + '"' : 'no ISP field'}${r.orgType ? ', network type ' + r.orgType : ''}${r.asnOrg ? ', ASN owner "' + r.asnOrg + '"' : ''}`).join('; ');
  if (!recs.length) return { ...D, reason: 'lookup-failed', detail: 'no provider returned data for this address' };
  const flag = recs.find(r => r.anonymizer);
  if (flag) return { ...D, reason: 'vpn', detail: `${flag.src} flags this address as a VPN, proxy or Tor exit, so it is not the visitor's own ISP` };
  const host = recs.find(r => r.hosting);
  if (host) return { ...D, reason: 'hosting', detail: `${host.src} classifies this address as a hosting or data-centre network` };

  const claims = recs.filter(r => r.isp && !vendorRecs.includes(r)).map(r => ({ name: r.isp, domain: r.domain, src: r.src, w: r.authoritative ? 3 : r.typed ? 2 : 1 }));
  D.claims = claims.map(c => ({ name: c.name, src: c.src, weight: c.w }));
  const ents = r => [{ name: r.isp, domain: r.domain }, { name: r.org, domain: r.domain }, { name: r.asnOrg, domain: r.domain }];

  // 1. cluster claims that name the same company, then count the independent sources that back each cluster
  const clusters = [];
  for (const c of claims) {
    const cl = clusters.find(k => linked(k, c, place));
    if (cl) { cl.claims.push(c); cl.srcs.add(c.src); cl.w = Math.max(cl.w, c.w); } else clusters.push({ name: c.name, domain: c.domain, claims: [c], srcs: new Set([c.src]), w: c.w });
  }
  for (const cl of clusters) {
    cl.support = recs.filter(r => !cl.srcs.has(r.src) && ents(r).some(e => linked(cl, e, place)));
    cl.n = cl.srcs.size + cl.support.length;
    cl.all = [...cl.srcs, ...cl.support.map(r => r.src)];
  }
  D.clusters = clusters.map(c => ({ name: c.name, sources: c.all, weight: c.w }));

  const authCl = clusters.find(k => k.w === 3);
  if (authCl) return { ...D, isp: authCl.name, confidence: 'high', sources: authCl.all, basis: 'ISP-level commercial database' };

  const nonIsp = recs.find(r => r.orgType && r.orgType !== 'isp');
  const ranked = [...clusters].sort((a, b) => (b.n - a.n) || (b.w - a.w));
  if (ranked.length > 1 && ranked[0].n === ranked[1].n && ranked[0].w === ranked[1].w) {
    return { ...D, reason: 'conflict', detail: `sources name different providers with equal support: ${ranked.slice(0, 3).map(c => `"${c.name}" (${c.all.join(', ')})`).join(' vs ')}` };
  }
  const top = ranked[0];
  if (top) {
    if (top.n >= 2) return { ...D, isp: top.name, confidence: 'high', sources: top.all, basis: `named as the ISP by ${top.claims.map(c => c.src).join(', ')}; the same company is matched by ${top.all.filter(s => !top.claims.some(c => c.src === s)).join(', ') || 'a second claim'}` };
    if (top.w >= 2) return { ...D, isp: top.name, confidence: 'medium', sources: top.all, basis: `${top.claims[0].src} classifies this network as an ISP; no second source confirms it` };
    if (!nonIsp) return { ...D, isp: top.name, confidence: 'medium', sources: top.all, basis: `${top.claims[0].src}'s ISP field only; no second source confirms it` };
    return { ...D, reason: 'conflict', detail: `${top.claims[0].src} names "${top.name}" as ISP, but ${nonIsp.src} classifies the network as ${nonIsp.orgType} ("${nonIsp.org}")` };
  }

  // 2. no source names an ISP. A network that a provider classifies as an ISP, whose ASN owner a second source
  //    corroborates, is accepted as supporting evidence (medium confidence); an ASN owner alone never is.
  const asIsp = recs.find(r => r.asnType === 'isp' && r.asnOrg && !VENDOR.test(r.asnOrg));
  if (asIsp) {
    const prov = { name: asIsp.asnOrg, domain: asIsp.domain };
    const backers = recs.filter(r => r !== asIsp && ents(r).some(e => linked(prov, e, place)));
    if (backers.length) return { ...D, isp: asIsp.org && linked(prov, { name: asIsp.org }, place) ? asIsp.org : asIsp.asnOrg, confidence: 'medium', sources: [asIsp.src, ...backers.map(r => r.src)], basis: `${asIsp.src} classifies the ASN owner as an ISP and ${backers.map(r => r.src).join(', ')} name the same organisation. The retail ISP is inferred, not stated by any provider` };
  }
  if (nonIsp) return { ...D, reason: 'not-isp', detail: `${nonIsp.src} classifies this network as ${nonIsp.orgType} ("${nonIsp.org}"), not a consumer ISP. ${names}${rej}` };
  return { ...D, reason: 'insufficient-evidence', detail: `no provider names a retail ISP for this address. ${names}${rej}` };
}

function consensusGeo(recs, hdr) {
  const gs = recs.filter(r => r.geo && (r.geo.city || r.geo.country || r.geo.cc)).map(r => ({ ...r.geo, src: r.src }));
  const norm = s => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
  /* each city is a vote. A clear winner is used. A tie is broken only by an independent hint (the CDN's header); otherwise NO city is
     chosen and the disagreement is reported, because picking one would present a guess as if the databases agreed. */
  const byCity = new Map();
  gs.forEach(g => { const k = norm(g.city); if (k) { const e = byCity.get(k) || { city: g.city, srcs: [] }; e.srcs.push(g.src); byCity.set(k, e); } });
  const ranked = [...byCity.entries()].sort((a, b) => b[1].srcs.length - a[1].srcs.length);
  let best = null, conflict = null;
  if (ranked.length) {
    const top = ranked.filter(e => e[1].srcs.length === ranked[0][1].srcs.length);
    if (top.length === 1) best = top[0][0];
    else { const h = hdr.city && top.find(e => e[0] === norm(hdr.city)); if (h) { best = h[0]; h[1].srcs.push('request-header'); } else conflict = ranked.map(e => ({ city: e[1].city, sources: e[1].srcs })); }
  }
  const pick = best ? (gs.find(g => norm(g.city) === best) || {}) : (gs.find(g => g.cc || g.country) || {});
  const winSrcs = best ? byCity.get(best).srcs : [];
  const cc = (pick.cc || hdr.cc || '').toUpperCase() || null;
  let country = pick.country || gs.map(g => g.country).find(Boolean) || null;
  if (!country && cc) { try { country = new Intl.DisplayNames(['en'], { type: 'region' }).of(cc); } catch { /* keep null */ } }
  if (conflict) { pick.city = null; pick.region = null; pick.lat = null; pick.lon = null; }
  const fromHeader = !pick.city && !conflict && !!hdr.city;
  const cities = new Set(gs.map(g => norm(g.city)).filter(Boolean));
  return {
    city: pick.city || hdr.city || null, region: pick.region || null, country, cc,
    lat: pick.lat ?? null, lon: pick.lon ?? null, tz: pick.tz || null,
    source: 'ip-estimate',                                  // never presented as a verified physical location
    basis: pick.city ? 'ip-databases' : fromHeader ? 'request-header' : (country ? 'country-only' : null),
    agree: pick.city ? winSrcs : [], cityConflict: conflict,
    cityAgreement: cities.size > 1 ? false : (gs.filter(g => g.city).length > 1 ? true : null),
    cityVotes: gs.map(g => ({ src: g.src, city: g.city, region: g.region, country: g.country, lat: g.lat ?? null, lon: g.lon ?? null }))
  };
}

async function lookup(ip, family, hdr) {
  const results = await Promise.all([pro.maxmind, pro.ipapiis, pro.ipwhois, pro.geojs, pro.ipinfo].map(p => run(p, ip)));
  const recs = results.filter(r => r.status === 'ok').map(r => r.rec);
  const geo = consensusGeo(recs, hdr);
  const place = new Set(words([geo.country, geo.cc, ...recs.map(r => r.geo?.country)].filter(Boolean).join(' ')));
  const d = decide(recs, place);

  const asns = [...new Set(recs.map(r => r.asn).filter(n => n != null))];
  const counts = new Map(); recs.forEach(r => { if (r.asn != null) counts.set(r.asn, (counts.get(r.asn) || 0) + 1); });
  const asn = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const asnRecs = recs.filter(r => r.asn === asn && r.asnOrg);
  const asnOrgRaw = (asnRecs.find(r => r.typed) || asnRecs[0])?.asnOrg || recs.find(r => r.asnOrg)?.asnOrg || recs.map(r => r.org).find(Boolean) || null;
  const asnOrg = pretty(asnOrgRaw);
  const opName = d.reason === 'vpn' || d.reason === 'hosting' ? (recs.map(r => r.org).find(Boolean) || asnOrg) : null;
  let ispName = pretty(d.isp || null), ispConfidence = d.confidence || null, ispReason = d.reason || null, ispDetail = d.detail || null, ispBasis = d.basis || null, ispSources = d.sources || [], ispNote = null;
  /* a name a person would recognise for the AS (see _asn-names.js). Only for an AS number the databases reported. */
  const fr = asn != null ? await friendlyAsn(asn) : null, asnRegistry = asnOrg, reporters = asnRecs.map(r => r.src);
  const blocked = ['vpn', 'hosting', 'not-isp', 'private-ip', 'cgnat-address'].includes(d.reason);
  let ispFromList = false;
  if (fr?.name && !blocked) {
    if (fr.isIsp && ['insufficient-evidence', 'low-confidence', 'conflict', null].includes(d.reason ?? null) && (!ispName || isHandle(ispName))) {
      ispName = fr.name; ispFromList = true; ispConfidence = 'medium'; ispReason = null; ispDetail = null;
      ispSources = [fr.source, ...reporters];
      ispBasis = `${fr.source} gives "${fr.name}" for AS${asn}${fr.source === 'PeeringDB' ? ` and lists it as an ISP${fr.type ? ' (' + fr.type + ')' : ''}` : ''}, and ${reporters.join(', ') || 'the IP databases'} report this AS number. No IP database gave a usable company name${asnRegistry ? `; they call the network "${asnRegistry}"` : ''}`;
      ispNote = fr.source === 'known-provider list' ? `Known provider for AS${asn}. The IP databases gave no company name for it, so this is not cross-checked.` : `Name from ${fr.source}, which lists AS${asn} as an ISP. The IP databases gave no company name, so this is not cross-checked.`;
    } else if (ispName && isHandle(ispName)) {
      const was = ispName; ispName = fr.name; ispSources = ispSources.length ? ispSources : [fr.source];
      ispNote = `The IP databases gave only the registry handle "${was}". Company name from ${fr.source}.`;
    }
  }
  const asnShown = fr?.name || asnOrg;
  /* a national/wholesale network (flagged in _known-asns.js): databases that merely restate its owner as "the ISP" do not prove the retail brand */
  if (fr?.shared && ispName && !blocked && [asnRegistry, fr.name].some(n => n && sameNetwork(ispName, n, place))) {
    ispDetail = `AS${asn} (${fr.name}) is a shared national network. ${ispSources.join(', ')} only name the network owner (\"${ispName}\"), which does not show which retail brand the visitor pays.`;
    ispName = null; ispConfidence = null; ispReason = 'shared-network'; ispBasis = null; ispSources = []; ispNote = null;
  }

  return {
    ip, family,
    isp: ispName, ispConfidence, ispReason, ispDetail,
    ispBasis, ispSources, ispNote,
    org: pretty(recs.map(r => r.org).find(Boolean) || null),
    connectionType: recs.map(r => r.connectionType).find(Boolean) || null,
    asn, asnOrg: asnShown, asnRegistryName: fr?.name && asnRegistry && !sameNetwork(asnRegistry, fr.name, place) ? asnRegistry : null, asnConflict: asns.length > 1 ? asns : null,
    operator: asnShown ? { name: asnShown, kind: recs.some(r => r.asnType === 'isp' && r.asn === asn) ? 'isp' : 'unknown' } : null,
    asnSameAsIsp: !!(ispName && asnShown && (ispFromList || sameNetwork(ispName, asnShown, place))),
    network: opName,
    mobile: recs.some(r => r.mobile) || null,
    geo,
    sources: recs.map(r => r.src),
    diag: {
      providers: results.map(r => ({ name: r.name, status: r.status, ms: r.ms ?? null, detail: r.detail || null,
        said: r.rec ? { isp: r.rec.isp || null, org: r.rec.org || null, orgType: r.rec.orgType || null, asn: r.rec.asn ?? null, asnOrg: r.rec.asnOrg || null, city: r.rec.geo?.city || null, country: r.rec.geo?.country || r.rec.geo?.cc || null } : null })),
      isp: { claims: d.claims, clusters: d.clusters, rejected: d.rejected, decision: ispName ? (ispFromList ? 'name from ' + fr.source : 'accepted') : 'unconfirmed', confidence: ispConfidence, basis: ispBasis, reason: ispReason, detail: ispDetail },
      asnName: fr ? { shownAs: asnShown, source: fr.source || null, ...fr.diag } : null,
      asn: { value: asn, org: asnOrgRaw, shownAs: asnShown, conflict: asns.length > 1 ? asns : null },
      geo: { chosen: [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || null, basis: geo.basis, agree: geo.agree, votes: geo.cityVotes }
    }
  };
}

export default async function handler(req) {
  const h = req.headers, url = new URL(req.url);
  const hdr = { city: dec(h.get('x-vercel-ip-city')), cc: h.get('x-vercel-ip-country') };
  const vercelId = h.get('x-vercel-id') || '';
  const region = (vercelId.split('::')[0] || '').trim() || null;

  const own = requestAddress(h);
  const asked = url.searchParams.get('ip');
  const target = asked ? parseIp(asked) : own;
  const base = { ip: target?.ip || null, requestIp: own?.ip || null, vercelRegion: region, isp: null, ispConfidence: null, ispReason: null, ispDetail: null, asn: null, asnOrg: null, geo: null };
  const early = (reason, detail, status = 200, extra = {}) => reply({ ...base, ...extra, ispReason: reason, ispDetail: detail, diag: { providers: [], isp: { decision: 'not-attempted', reason, detail } } }, status);

  if (asked && !target) return early('invalid-ip', 'the ip parameter is not a valid IPv4/IPv6 address', 400);
  if (!target) return early('no-ip', 'the request carried no client address (local server without a proxy header?)');
  const cls = addressClass(target.ip, target.family);
  if (cls === 'private') return early('private-ip', `${target.ip} is a private or loopback address, so no public database knows it. The page uses the address Cloudflare reports instead`, 200, { family: target.family });
  if (cls === 'cgnat') return early('cgnat-address', `${target.ip} is in carrier-grade NAT space (100.64.0.0/10) and cannot be looked up`, 200, { family: target.family });

  // Looking up an address other than the caller's own is limited, so the endpoint can't be used as a free proxy
  if (target.ip !== own?.ip) {
    const who = own?.ip || 'anon', now = Date.now(), q = quota.get(who);
    if (!q || now - q.t > 60000) quota.set(who, { t: now, n: 1 });
    else if (++q.n > 20) return early('rate-limited', 'more than 20 lookups for other addresses in one minute', 429, { family: target.family });
    if (quota.size > 2000) quota.clear();
  }

  const hit = cache.get(target.ip);
  if (hit && Date.now() - hit.t < TTL_MS) return reply({ ...hit.data, requestIp: base.requestIp, vercelRegion: region, cached: true });

  const data = await lookup(target.ip, target.family, hdr);
  if (!data.sources.length) {            // every provider failed: answer, but do not cache, so the next call retries
    const fails = data.diag.providers.filter(p => p.status !== 'ok').map(p => `${p.name}: ${p.status}${p.detail ? ' (' + p.detail + ')' : ''}`).join('; ');
    return reply({ ...data, vercelRegion: region, requestIp: base.requestIp, ispReason: 'lookup-failed', ispDetail: `no provider returned data. ${fails}` });
  }
  if (cache.size > 500) cache.clear();
  cache.set(target.ip, { t: Date.now(), data });
  return reply({ ...data, requestIp: base.requestIp, vercelRegion: region });
}
