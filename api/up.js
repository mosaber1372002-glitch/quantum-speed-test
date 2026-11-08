export const config = { runtime: 'edge' };
export default async function handler(req) {
  if (req.body) { const r = req.body.getReader(); for (;;) { const { done } = await r.read(); if (done) break; } }
  return new Response('ok', { headers: { 'cache-control': 'no-store' } });
}
