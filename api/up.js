export const config = { runtime: 'edge' };
/* Reads and discards the uploaded bytes so the browser can time the transfer. Bounded, so the endpoint cannot be used to push unlimited data. */
const MAX = 64e6;
export default async function handler(req) {
  let n = 0;
  if (req.body) {
    const r = req.body.getReader();
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      n += value.length;
      if (n > MAX) { try { await r.cancel(); } catch { /* ignore */ } return new Response('too large', { status: 413, headers: { 'cache-control': 'no-store' } }); }
    }
  }
  return new Response('ok', { headers: { 'cache-control': 'no-store' } });
}
