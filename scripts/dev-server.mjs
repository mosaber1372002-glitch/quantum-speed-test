#!/usr/bin/env node
/*
 * Local server that behaves like the Vercel deployment: it serves the static page AND runs the real /api edge
 * functions (api/*.js) in plain Node, with no dependencies and no Vercel login.
 *
 *   npm start            -> http://localhost:3000   (PORT=4000 npm start to change it)
 *   npm run check        -> starts on a free port, calls every endpoint once, prints a PASS/FAIL table, exits
 *
 * Why this exists: `serve .` only serves files, so every /api/* route answers 404 and the page then has no IP, ISP,
 * location or server directory to show. That looks like a geolocation/ISP database failure but is not one.
 *
 * Differences from Vercel, handled here:
 *   - Locally the browser connects from 127.0.0.1, which no IP database knows. The server looks up its own public
 *     address once (api.ipify.org, then Cloudflare's /meta) and passes it to the functions as the client address.
 *     That is correct whenever the browser and this server are on the same machine/network, which is the local case.
 *   - Vercel's x-vercel-ip-city / x-vercel-ip-country headers do not exist locally (they stay empty).
 *   - Secrets come from .env.local or .env (see .env.example); real environment variables win over the files.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_DIR = path.join(ROOT, 'api');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const ENV_NAMES = ['IPAPI_IS_KEY', 'IPINFO_TOKEN', 'MAXMIND_ACCOUNT_ID', 'MAXMIND_LICENSE_KEY', 'MAXMIND_SERVICE', 'LIBRESPEED_LIST_URL', 'LOOKUP_TIMEOUT_MS'];

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined && v !== '') process.env[m[1]] = v;
    }
  }
}

const isPrivate = ip => !ip || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip) || ip === '::';
const clean = ip => (ip || '').replace(/^::ffff:/, '');

/* this machine's public address, looked up once and cached; null if offline */
let pub = { ip: null, t: 0, why: null };
async function publicIp() {
  if (Date.now() - pub.t < 5 * 60 * 1000) return pub;
  const tries = [['api.ipify.org', async () => (await (await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) })).json()).ip],
                 ['speed.cloudflare.com/meta', async () => (await (await fetch('https://speed.cloudflare.com/meta', { signal: AbortSignal.timeout(4000) })).json()).clientIp]];
  const errs = [];
  for (const [n, f] of tries) { try { const ip = await f(); if (ip) { pub = { ip, t: Date.now(), why: null }; return pub; } } catch (e) { errs.push(`${n}: ${e?.cause?.code || e?.message || e}`); } }
  pub = { ip: null, t: Date.now(), why: errs.join('; ') || 'no answer' };
  return pub;
}

async function loadRoutes() {
  const routes = new Map();
  for (const f of fs.readdirSync(API_DIR).filter(f => /\.(m?js)$/.test(f))) {
    const mod = await import(pathToFileURL(path.join(API_DIR, f)).href);
    if (typeof mod.default !== 'function') throw new Error(`api/${f} has no default export`);
    routes.set(f.replace(/\.m?js$/, ''), mod.default);
  }
  return routes;
}

export async function start({ port = 0, quiet = false } = {}) {
  loadEnv();
  const routes = await loadRoutes();
  const log = (...a) => { if (!quiet) console.log(...a); };

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/api\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    try {
      if (m) {
        const fn = routes.get(m[1]);
        if (!fn) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'no such api route', route: url.pathname, available: [...routes.keys()].map(k => '/api/' + k) })); return log(`[api] ${req.method} ${url.pathname} 404 (no such route)`); }
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        let ip = clean(req.socket.remoteAddress), note = '';
        if (isPrivate(ip)) { const p = await publicIp(); if (p.ip) { ip = p.ip; note = ' (public IP of this machine)'; } else note = ` (could not find this machine's public IP: ${p.why})`; }
        headers.set('x-vercel-forwarded-for', ip); headers.set('x-vercel-id', 'dev1::dev1::local');
        const hasBody = !['GET', 'HEAD'].includes(req.method);
        const request = new Request(url.href, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' });
        const out = await fn(request);
        const h = {}; out.headers.forEach((v, k) => { h[k] = v; });
        res.writeHead(out.status, h);
        if (out.body) { const s = Readable.fromWeb(out.body); res.on('close', () => s.destroy()); s.pipe(res); await new Promise(r => res.on('close', r)); } else res.end();
        let extra = '';
        if (m[1] === 'meta' && /json/.test(h['content-type'] || '')) {
          try { const j = await out.clone().json(); extra = ` ip=${j.ip}${note} isp=${j.isp || 'none'}${j.ispReason ? ' (' + j.ispReason + ')' : ''} asn=${j.asn ?? '-'} | ${(j.diag?.providers || []).map(p => `${p.name}:${p.status}${p.detail ? '(' + p.detail + ')' : ''}`).join(' ')}`; } catch { /* body already consumed */ }
        }
        return log(`[api] ${req.method} ${url.pathname}${url.search.length > 60 ? url.search.slice(0, 60) + '…' : url.search} ${out.status} ${Date.now() - t0}ms${extra}`);
      }
      // static files (never dotfiles, secrets, sources of the functions or this script)
      let rel = decodeURIComponent(url.pathname); if (rel.endsWith('/')) rel += 'index.html';
      const file = path.join(ROOT, rel);
      const top = path.relative(ROOT, file).split(path.sep)[0];
      if (!file.startsWith(ROOT) || /^\./.test(path.basename(file)) || ['api', 'scripts', 'node_modules'].includes(top) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      console.error('[server error]', url.pathname, e);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'handler threw', detail: String(e?.message || e) }));
    }
  });
  await new Promise((ok, bad) => { server.once('error', bad); server.listen(port, ok); });
  return { server, routes, port: server.address().port };
}

/* every endpoint once; a route is OK when it executes (status < 500, JSON where expected). Upstream outages are reported, not blamed on the route. */
export async function check(port) {
  const base = `http://localhost:${port}`, rows = [];
  const hit = async (label, p, init, verify) => {
    const t0 = Date.now();
    try {
      const r = await fetch(base + p, { ...init, signal: AbortSignal.timeout(20000) });
      const v = await verify(r);
      rows.push({ label, ok: v.ok, status: r.status, ms: Date.now() - t0, note: v.note });
    } catch (e) { rows.push({ label, ok: false, status: '-', ms: Date.now() - t0, note: String(e?.message || e) }); }
  };
  await hit('/api/meta', '/api/meta', {}, async r => { const j = await r.json(); const prov = (j.diag?.providers || []).map(p => `${p.name}=${p.status}`).join(' '); return { ok: r.status < 500 && 'ip' in j, note: `ip=${j.ip} isp=${j.isp || 'none'}${j.ispReason ? ' (' + j.ispReason + ')' : ''}  ${prov}` }; });
  await hit('/api/geo', '/api/geo?lat=31.2&lon=29.92', {}, async r => { const j = await r.json(); return { ok: 'city' in j || typeof j.error === 'string', note: j.error ? `route runs; upstream: ${j.error} ${(j.tried || []).map(t => `${t.name}=${t.status}${t.detail ? '(' + t.detail + ')' : ''}`).join(' ')}` : `${[j.city, j.region, j.country].filter(Boolean).join(', ')} via ${j.provider}` }; });
  await hit('/api/servers', '/api/servers', {}, async r => { const j = await r.json(); const d = j.directory || {}; return { ok: r.status < 500 && Array.isArray(j.servers), note: `directory ${d.state}${d.error ? ' (' + d.error + ')' : ''}: ${d.usable ?? 0} usable servers` }; });
  await hit('/api/down', '/api/down?bytes=100000', {}, async r => { const n = (await r.arrayBuffer()).byteLength; return { ok: r.ok && n === 100000, note: `${n} bytes` }; });
  await hit('/api/up', '/api/up', { method: 'POST', body: new Uint8Array(100000) }, async r => ({ ok: r.ok, note: `${(await r.text()).slice(0, 20)}` }));
  await hit('static /', '/', {}, async r => { const t = await r.text(); return { ok: r.ok && /<title>/i.test(t), note: `${t.length} bytes` }; });
  return rows;
}

const direct = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  const wantCheck = process.argv.includes('--check');
  const want = wantCheck ? 0 : Number(process.env.PORT || 3000);
  start({ port: want, quiet: wantCheck }).then(async ({ server, routes, port }) => {
    if (wantCheck) {
      const rows = await check(port);
      console.log('\nEndpoint check (routes executing in Node, same code as on Vercel)\n');
      for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(13)} ${String(r.status).padEnd(4)} ${String(r.ms).padStart(5)} ms  ${r.note}`);
      const bad = rows.filter(r => !r.ok).length;
      console.log(bad ? `\n${bad} endpoint(s) failed to execute.\n` : '\nAll endpoints execute. Any "upstream" notes above are about third-party services, not this project.\n');
      server.close(); process.exit(bad ? 1 : 0);
    }
    console.log(`\n  Quantum Speed Test (local, with API)\n  http://localhost:${port}\n`);
    console.log(`  API routes : ${[...routes.keys()].map(k => '/api/' + k).join('  ')}`);
    console.log(`  Optional keys (names only): ${ENV_NAMES.map(n => `${n}=${process.env[n] ? 'set' : 'not set'}`).join('  ')}`);
    console.log('  Each /api/meta call prints which IP databases answered, failed or were skipped.\n');
  }).catch(e => { console.error(e.code === 'EADDRINUSE' ? `Port ${want} is already in use. Try: PORT=${want + 1} npm start` : e); process.exit(1); });
}
