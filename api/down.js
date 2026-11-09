export const config = { runtime: 'edge' };
/* Random bytes, a fresh block every time, and marked as not to be transformed. Repeated or zero-filled data can be compressed by a CDN
   in transit, and then the browser counts far more bytes than ever crossed the visitor's line (an inflated speed). */
export default function handler(req) {
  const n = Math.min(parseInt(new URL(req.url).searchParams.get('bytes') || '0', 10) || 0, 25e6);
  const h = { 'content-type': 'application/octet-stream', 'cache-control': 'no-store, no-transform', 'content-encoding': 'identity', 'x-content-type-options': 'nosniff' };
  if (!n) return new Response('', { headers: h });
  let sent = 0;
  return new Response(new ReadableStream({
    pull(c) {
      if (sent >= n) return c.close();
      const l = Math.min(65536, n - sent), chunk = new Uint8Array(l);
      crypto.getRandomValues(chunk);
      c.enqueue(chunk);
      sent += l;
    }
  }), { headers: h });
}
