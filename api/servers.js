export const config = { runtime: 'edge' };

/*
 * /api/servers: candidate test servers beyond Cloudflare and this site.
 *
 * Source: the public LibreSpeed server directory (open-source speed-test project; its volunteer-run
 * servers are built to be used from a browser). Entries carry no coordinates and no country field: the country
 * is read from the entry's name ("City, Country (Sponsor)") and mapped to an ISO code; where that fails `cc` is
 * null. `lat`/`lon` are only an approximate position for the COUNTRY (posKind: 'country-centroid'), never a server
 * location. Which server is chosen is decided in the browser by measured latency and throughput.
 * The response also reports the state of the directory itself, so "no servers" and "directory unreachable" differ.
 *
 * The directory URL can be overridden with LIBRESPEED_LIST_URL. If it is unreachable the response is
 * an empty list and the site keeps working with Cloudflare / this site's own endpoints.
 */

const LIST_URL = (typeof process !== 'undefined' && process.env && process.env.LIBRESPEED_LIST_URL) || 'https://librespeed.org/backend-servers/servers.php';
const TTL_MS = 6 * 60 * 60 * 1000;
let cached = null; // { t, list }
let status = { state: 'unloaded', error: null, at: null, raw: 0 };

const abs = (base, p) => { try { return new URL(p, base).href; } catch { return null; } };

/* Country name -> ISO code, built from the platform's own region names plus a few spellings directories use */
const ALIASES = { usa: 'US', us: 'US', 'united states of america': 'US', uk: 'GB', 'great britain': 'GB', england: 'GB', russia: 'RU', 'russian federation': 'RU', czechia: 'CZ', 'czech republic': 'CZ', 'south korea': 'KR', korea: 'KR', turkey: 'TR', turkiye: 'TR', uae: 'AE', 'hong kong': 'HK', taiwan: 'TW', vietnam: 'VN', 'viet nam': 'VN', 'ivory coast': 'CI', 'the netherlands': 'NL', holland: 'NL', macedonia: 'MK', burma: 'MM' };
let byName = null;
function countryCode(name) {
  const k = (name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!k) return null;
  if (ALIASES[k]) return ALIASES[k];
  if (!byName) {
    byName = new Map();
    try {
      const dn = new Intl.DisplayNames(['en'], { type: 'region' });
      for (let i = 65; i <= 90; i++) for (let j = 65; j <= 90; j++) {
        const cc = String.fromCharCode(i, j), n = dn.of(cc);
        if (n && n !== cc) byName.set(n.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim(), cc);
      }
    } catch { /* leave empty: the browser falls back to name matching */ }
  }
  return byName.get(k) || null;
}

/* Approximate country positions (lat,lon of a central point). They are NOT server locations: the directory gives none.
   They are used only to decide WHICH servers the browser pings first when the visitor's own country has none or few;
   which server is actually chosen is always decided by measured latency and throughput. Countries missing here are
   simply ranked after the ones that are listed. */
const CENTROIDS = ('AD:42.5,1.6 AE:24,54 AF:33,65 AL:41,20 AM:40,45 AO:-12.5,18.5 AR:-34,-64 AT:47.5,14.5 AU:-25,134 AW:12.5,-70 AZ:40.5,47.5 BA:44,18 BB:13.2,-59.5 BD:24,90 BE:50.8,4.5 BF:12.3,-1.7 BG:42.7,25.5 BH:26,50.5 BJ:9.5,2.3 BN:4.5,114.7 BO:-17,-65 BR:-10,-55 BS:25,-77.4 BT:27.5,90.5 BW:-22,24 BY:53.7,28 BZ:17.2,-88.7 CA:56,-106 CD:-3,23 CG:-1,15 CH:47,8 CI:7.5,-5.5 CL:-30,-71 CM:6,12.5 CN:35,105 CO:4,-72 CR:10,-84 CU:21.5,-80 CW:12.2,-69 CY:35,33 CZ:49.8,15.5 DE:51,10 DJ:11.8,42.6 DK:56,10 DO:19,-70.5 DZ:28,3 EC:-2,-77.5 EE:59,26 EG:27,30 ER:15.2,39.8 ES:40,-4 ET:8,39 FI:64,26 FJ:-18,178 FO:62,-7 FR:46.5,2.5 GA:-0.8,11.6 GB:54,-2 GE:42,43.5 GG:49.5,-2.6 GH:8,-1 GI:36.1,-5.4 GL:72,-40 GR:39,22 GT:15.5,-90 GY:5,-59 HK:22.3,114.2 HN:15,-86.5 HR:45.1,15.2 HT:19,-72.4 HU:47,20 ID:-2,118 IE:53,-8 IL:31.5,35 IM:54.2,-4.5 IN:21,78 IQ:33,44 IR:32,53 IS:65,-18 IT:42.8,12.8 JE:49.2,-2.1 JM:18.1,-77.3 JO:31,36 JP:36,138 KE:0,38 KG:41,75 KH:12.5,105 KR:36.5,128 KW:29.3,47.7 KZ:48,68 LA:18,103 LB:33.9,35.9 LI:47.2,9.5 LK:7.9,80.7 LS:-29.6,28.2 LT:55.3,23.9 LU:49.8,6.1 LV:57,25 LY:27,17 MA:32,-6 MC:43.7,7.4 MD:47,29 ME:42.7,19.4 MG:-19,47 MK:41.6,21.7 ML:17,-4 MM:21,96 MN:46,105 MO:22.2,113.5 MT:35.9,14.4 MU:-20.3,57.6 MV:3.2,73.2 MW:-13.5,34 MX:23,-102 MY:4,102 MZ:-18.7,35 NA:-22,17 NC:-21.5,165.5 NE:17,9 NG:9,8 NI:13,-85 NL:52.2,5.3 NO:62,10 NP:28,84 NZ:-41,174 OM:21,57 PA:9,-80 PE:-10,-76 PF:-17.7,-149.4 PG:-6,147 PH:13,122 PK:30,70 PL:52,19 PR:18.2,-66.5 PS:31.9,35.2 PT:39.5,-8 PY:-23,-58 QA:25.3,51.2 RE:-21.1,55.5 RO:46,25 RS:44,21 RU:60,100 RW:-2,30 SA:24,45 SC:-4.7,55.5 SD:15,30 SE:62,15 SG:1.35,103.8 SI:46,14.8 SK:48.7,19.5 SM:43.9,12.5 SN:14.5,-14.5 SO:5,46 SR:4,-56 SS:7,30 SV:13.8,-88.9 SY:35,38 SZ:-26.5,31.5 TD:15,19 TG:8.6,1 TH:15,101 TJ:39,71 TM:40,59 TN:34,9 TR:39,35 TT:10.7,-61.2 TW:23.7,121 TZ:-6,35 UA:49,32 UG:1,32 US:38,-97 UY:-33,-56 UZ:41,64 VE:8,-66 VN:16,106 XK:42.6,20.9 YE:15.5,47.5 ZA:-29,24 ZM:-15,28 ZW:-19,29.5')
  .split(' ').reduce((m, e) => { const [c, p] = e.split(':'); const [la, lo] = p.split(',').map(Number); m[c] = [la, lo]; return m; }, {});

function normalise(e, i) {
  if (!e || typeof e !== 'object' || !e.server || !e.dlURL || !e.ulURL || !e.pingURL) return null;
  const s = String(e.server).startsWith('//') ? 'https:' + e.server : String(e.server);
  let base; try { base = new URL(s).href; } catch { return null; }
  if (!base.startsWith('https://')) return null;                    // browsers block http from an https page
  const dl = abs(base, e.dlURL), ul = abs(base, e.ulURL), ping = abs(base, e.pingURL);
  if (!dl || !ul || !ping) return null;
  // Names look like "Frankfurt, Germany (Clouvider) (10 Gbps)": drop every parenthetical, keep the first as the sponsor
  const raw = String(e.name || '').trim().slice(0, 160);
  const groups = [...raw.matchAll(/\(([^)]*)\)/g)].map(m => m[1].trim()).filter(Boolean);
  const place = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const sponsor = (typeof e.sponsorName === 'string' && e.sponsorName.trim().slice(0, 80)) || groups[0] || null;
  const country = place.includes(',') ? place.split(',').pop().trim() : null;
  const cc = countryCode(country), c = cc && CENTROIDS[cc];
  const city = place.includes(',') ? place.split(',').slice(0, -1).join(',').trim() || null : null;
  return { id: String(e.id ?? i), name: place || raw, city, sponsor, country, cc, lat: c ? c[0] : null, lon: c ? c[1] : null, posKind: c ? 'country-centroid' : null, dl, ul, ping };
}

async function load() {
  if (cached && Date.now() - cached.t < TTL_MS) return cached.list;
  const c = new AbortController(), t = setTimeout(() => c.abort(), 5000);
  try {
    const r = await fetch(LIST_URL, { signal: c.signal, headers: { accept: 'application/json' } });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    const raw = await r.json();
    if (!Array.isArray(raw)) throw new Error('the directory did not return a JSON list');
    const list = raw.map(normalise).filter(Boolean).slice(0, 400);
    cached = { t: Date.now(), list };
    status = { state: 'ok', error: null, at: new Date().toISOString(), raw: raw.length };
    return list;
  } catch (e) {
    const msg = e?.name === 'AbortError' ? 'timeout after 5000 ms' : e?.status ? 'HTTP ' + e.status : e instanceof SyntaxError ? 'response was not valid JSON' : String(e?.message || e).slice(0, 100) + (e?.cause?.code ? ` (${e.cause.code})` : '');
    status = { state: cached ? 'stale' : 'failed', error: msg, at: status.at, raw: status.raw };
    return cached ? cached.list : [];
  } finally { clearTimeout(t); }
}

export default async function handler(req) {
  const list = await load();
  const region = ((req.headers.get('x-vercel-id') || '').split('::')[0] || '').trim() || null;
  const withCc = list.filter(x => x.cc).length;
  // a failed or empty directory must not be cached by browsers or the CDN, or one bad moment would stick for an hour
  const good = status.state === 'ok' && list.length > 0;
  return new Response(JSON.stringify({ servers: list, vercelRegion: region, directory: { url: LIST_URL, state: status.state, error: status.error, entries: status.raw, usable: list.length, withCountry: withCc } }), {
    headers: { 'content-type': 'application/json', 'cache-control': good ? 'public, max-age=300, s-maxage=3600' : 'no-store' }
  });
}
