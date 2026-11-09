# Quantum Speed Test: cyberpunk internet speed test

A static site (no build step). Measures real download, upload, ping and jitter against Cloudflare's speed endpoints, and detects IP, ISP, location and device live.

## Run locally
```
npm install
npm start          # http://localhost:3000  runs the page AND the real /api handlers (Node 18+, no login needed)
npm run check      # starts its own temporary server and tests /api/meta, geo, servers, down, up
npm run dev        # alternative: Vercel's own emulator (needs `npx vercel login`); behaves the same
npm run start:static   # static files only. There are NO /api routes in this mode (see below)
```
`npm start` used to be a static file server. A static server cannot run anything under `/api`, so every lookup failed and the page
could only show Cloudflare. That is a local setup problem, not an IP-database failure, and the page now says so
("Needs the /api routes") instead of "Not detectable". `npm start` now runs `scripts/dev-server.mjs`, which executes the same
`api/*.js` files Vercel runs. It also looks up this machine's public IP (ipify, falling back to Cloudflare) because `localhost` has no
public address of its own. Copy `.env.example` to `.env.local` to add optional provider keys.

### Diagnostics
Open the page with `?debug` at the end of the address (or run `localStorage.setItem('quantum.debug','1')`). A DIAGNOSTICS box appears at the bottom of the page with a
COPY DIAGNOSTICS button (works on phones, no console needed; the IP address is masked in the copy), the console logs each step, and `quantumDiag()` returns the same object at any time.
It never contains keys or tokens.
- **location**: browser permission and position state, reverse-geocoder tried/failed, each IP database's vote, the final place and its source
- **isp**: per-provider status/latency/detail, the claims and clusters considered, ASN and its organisation, confidence, reason when unconfirmed
- **server**: directory state, found / reachable / verified counts, every candidate's latency, throughput and upload result, the selected server

## Deploy: GitHub, then Vercel
1. Create a new empty repo on github.com (e.g. `quantum-speed-test`).
2. Upload everything (`index.html`, `package.json`, `api/`, `scripts/`, `vercel.json`, `README.md`, `.gitignore`, `.vercelignore`, `.env.example`) (drag them into the repo page, or use git:
   `git init && git add . && git commit -m "Quantum Speed Test" && git branch -M main && git remote add origin <your-repo-url> && git push -u origin main`).
3. Go to vercel.com, choose **Add New, Project**, import the repo, leave every setting at its default (Framework: Other, no build command), then **Deploy**.
4. You get a free `https://your-project.vercel.app` address.

## Custom domain
Vercel project, **Settings, Domains**, add your domain, then set the DNS records Vercel shows you at your registrar.

## Test servers and selection
The page measures against the best of several candidates, chosen the way Ookla documents its own approach (geolocate, shortlist nearby servers, ping them, pick the lowest latency), using only endpoints it may legitimately use:

- **Public LibreSpeed servers** (`api/servers.js`): volunteer-run servers from the open LibreSpeed directory. Their backends answer a page on another website only when the request carries `cors=true` (documented by LibreSpeed); the page sends it, otherwise every server looks unreachable. Each entry's name, city, country and sponsor are read from the directory; the directory publishes no coordinates, so nearness is decided by city and country match, then by distance between country centres (never shown as a server location).
- **Cloudflare** (`speed.cloudflare.com`). It is *anycast*: the network decides which edge answers. It is shown as "Cloudflare Speed Test Endpoint" with a separate "Edge location" (for example Marseille), never as a dedicated server in that city or as your location.
- **This site's own edge function** (`api/down.js`, `api/up.js`): a fallback if the others are blocked.

Shortlist order: your city, your country, nearby countries, then the rest. Every shortlisted server is pinged (warm-up plus 4 timed requests; it must answer most of them), the nearest must then complete a 1 MB download **and** a 300 KB upload, and any server that fails is excluded and listed as unavailable with the reason. Automatic mode takes the lowest measured latency among verified servers (dropping only grossly degraded ones); near-ties go to the closer tier. Cloudflare and this site get no preference and no penalty. Ookla's own list is not used: it is not a public, licensed API.

## Network identification
`api/meta.js` resolves the visitor's IP from Vercel's trusted headers (and, on dual-stack networks, the address the speed-test traffic really uses) and cross-checks independent sources server-side. **ISP** (retail provider) and **ASN** (network owner) are separate fields: an ASN or organisation name is never promoted to "ISP". The ASN row shows the AS number with its registered organisation (the network operator). The ISP row is filled only when sources agree on a retail provider, or one source types the network as an ISP and another supports the same organisation; otherwise it says "Not confirmed" with the reason (conflict, VPN, hosting, business network, no source naming an ISP, all databases failed) and the network operator.

Free sources (ipapi.is, ipwho.is) often cannot name the retail ISP. For that, add a commercial ISP-level database. Optional environment variables (Vercel, Settings, Environment Variables; read only on the server):

| Variable | Effect |
|---|---|
| `MAXMIND_ACCOUNT_ID`, `MAXMIND_LICENSE_KEY` | Enables MaxMind GeoIP2 Insights (paid), treated as authoritative for the ISP. Set `MAXMIND_SERVICE=city` for the City Plus plan. |
| `IPINFO_TOKEN` | Adds ipinfo.io as a third source (free plan gives geolocation + ASN only). |
| `IPAPI_IS_KEY` | Raises the ipapi.is free limit (1000 lookups/day). |
| `LIBRESPEED_LIST_URL` | Overrides the LibreSpeed directory URL. |

Responses are `no-store`; the only cache is a 10-minute per-isolate map keyed by IP address, so a new connection can never receive the previous connection's data. The page re-identifies on network-change events, when the device comes back online, when the tab returns after a minute, and every few minutes while idle.


### Company names instead of registry handles
Registries name a network by a handle ("TE-AS", "COMCAST-7922"). `api/_asn-names.js` finds the name a person would recognise, for any AS number worldwide, in this order:
1. `api/_known-asns.js`: a list you curate (brand names such as "WE (Telecom Egypt)"). Add one line per AS number to override or extend it.
2. **PeeringDB** (free, no key): the operator's own business name and network type. "Cable/DSL/ISP" counts as a retail provider.
3. **RIPEstat** (free, no key, all five registries): the registered holder, used for a display name only.
The name is looked up only for an AS number the IP databases reported, cached for a day, and shown as the Network identifier ("AS55836 · Reliance Jio Infocomm", with the registry handle in small text). It is used as the Internet provider only when no database named a usable ISP and the list or PeeringDB marks the network as a retail provider, and the row says so. It is never used for VPN, hosting or business networks. If every source fails, the databases' own name is kept and the diagnostics say why.
### Rules the provider detection follows
- The ISP and the network operator (the owner of the AS number) are separate rows and are never treated as the same thing.
- A maker of routers or network equipment (TP-Link, Huawei, ZTE, ...) is never accepted as an ISP; it is listed under `rejected` in the diagnostics.
- A network flagged `shared: true` in `api/_known-asns.js` (a national or wholesale network, AS8452 for example) is shown as the operator, but its owner is never assumed to be the visitor's retail brand; the provider row stays "Not confirmed" unless a database names a different retail provider.
- VPN, hosting and business networks never get a provider name.

### Location: when databases disagree
Each database's city is a vote. A clear majority wins. A tie is settled only by an independent hint (Cloudflare's or Vercel's own estimate naming one of the proposed cities). Otherwise no city is shown: the row says "Country only" and lists who said what. Device location, when granted, always comes first.

### Data use
Discovery pings up to about 16 servers (a few KB each) and verifies at most 3 plus the two built-in endpoints (about 1.3 MB each). Verification results are remembered for 10 minutes and dropped when the public IP changes, so refreshing or updating the location does not repeat them. A speed test itself is capped at about 8 seconds per direction.

### Router settings
The ROUTER row is a link that opens the router's own login page (for example `http://192.168.1.1/`) in a new tab. Browsers do not reveal the router's address to websites, so the visitor picks or types it (common ones are suggested, and the choice is remembered in the browser). The page never contacts that address, scans the network, or sees the login; only private IPv4 addresses are accepted. It works only while the visitor is on that router's network.

### Security
`/api/up` rejects bodies over 64 MB, `/api/down` caps a response at 25 MB, `/api/meta?ip=` lookups are rate-limited, and `vercel.json` sets `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (geolocation for this site only) and `X-Frame-Options`.

## Location
1. **Device location** (precise): requested once when the page opens (the visitor can refuse) and again with the button, rounded to ~1 km, turned into a place name by `api/geo.js` (Nominatim, then Photon if Nominatim fails), kept in memory, never stored.
2. **IP location** (approximate), used whenever device location is missing, denied, too imprecise or its place name cannot be resolved. It does not depend on any browser permission: the IP databases in `api/meta.js` are cross-checked, then Cloudflare's own estimate, then a direct ipwho.is lookup from the browser.
The row says which one it is ("Device location, accurate to ~35 m" or "Estimated from IP (2 IP databases agree)"). A city is never guessed: if no source has one, only the country is shown, and if none has anything the row says why.

## Notes
- It must be served over https (Vercel does this) for the test to run reliably on phones.
- A full test can use up to ~400 MB of data.
