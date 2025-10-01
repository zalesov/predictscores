// pages/api/debug/kv.js
// Single-store KV debug reader with robust GET (path + pipeline)

function resolveKV() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env missing');
  return { url, token };
}

async function kvGet(key) {
  const { url, token } = resolveKV();
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}?token=${token}`);
    if (r.ok) {
      const j = await r.json();
      let v = j?.result ?? null;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch(_){} }
      return v;
    }
  } catch (_) {}
  try {
    const r2 = await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify([['GET', key]]),
    });
    if (r2.ok) {
      const arr = await r2.json();
      let v = arr?.[0]?.result ?? null;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch(_){} }
      return v;
    }
  } catch (_) {}
  return null;
}

export default async function handler(req, res) {
  try {
    const key = String(req.query.key || '');
    if (!key) return res.status(200).json({ ok:false, error:'missing key' });

    const value = await kvGet(key);
    const { url, token } = resolveKV();

    return res.status(200).json({
      ok: true,
      kv: {
        url,
        hasToken: !!token,
        inspectedKey: key,
        isArray: Array.isArray(value) ? 1 : 0,
        value,
        hint: 'Za dan: ?key=vb:day:YYYY-MM-DD:last (treba da bude LISTA). Ako je string/pointer, pozovi /api/score-sync?ymd=YYYY-MM-DD ili /api/history-check?days=3.',
      },
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
