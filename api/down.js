export const config = { runtime: 'edge' };
export default function handler(req) {
  const n = Math.min(parseInt(new URL(req.url).searchParams.get('bytes') || '0', 10) || 0, 25e6);
  const h = { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' };
  if (!n) return new Response('', { headers: h });
  const chunk = new Uint8Array(65536);
  for (let i = 0; i < chunk.length; i += 65536) crypto.getRandomValues(chunk.subarray(i, i + 65536));
  let sent = 0;
  return new Response(new ReadableStream({
    pull(c) {
      if (sent >= n) return c.close();
      const l = Math.min(65536, n - sent);
      c.enqueue(l === 65536 ? chunk : chunk.subarray(0, l));
      sent += l;
    }
  }), { headers: h });
}
