// pages/api/debug/kv.js
// Uses REST (Upstash/Vercel KV) – no extra deps

function kvEnv() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env missing');
  return { url, token };
}

async function kvGet(key) {
  const { url, token } = kvEnv();
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}?token=${token}`);
  const j = await r.json();
  let v = j?.result ?? null;
  // Try JSON decode (arrays/objects stored as strings)
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (_) {}
  }
  return v;
}

export default async function handler(req, res) {
  try {
    const key = String(req.query.key || '');
    if (!key) return res.status(200).json({ ok: false, error: 'missing key' });

    const value = await kvGet(key);
    const isArray = Array.isArray(value);
    const url =
      process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;

    return res.status(200).json({
      ok: true,
      kv: {
        url,
        hasToken: Boolean(
          process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN
        ),
        inspectedKey: key,
        isArray: isArray ? 1 : 0,
        value,
        hint:
          'Za dan: ?key=vb:day:YYYY-MM-DD:last (treba da bude LISTA). Ako je string/pointer, pozovi /api/score-sync?ymd=YYYY-MM-DD ili /api/history-check?days=3.',
      },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
