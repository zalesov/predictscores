// pages/api/debug/kv.js
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  try {
    const key = String(req.query.key || '');
    if (!key) return res.status(200).json({ ok: false, error: 'missing key' });

    const value = await kv.get(key);
    const isArray = Array.isArray(value);
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;

    return res.status(200).json({
      ok: true,
      kv: {
        url,
        hasToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN),
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
