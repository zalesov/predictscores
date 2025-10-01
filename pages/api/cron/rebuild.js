// pages/api/cron/rebuild.js
// REST-based KV + ensure union from snapshot chunks (no external deps added)

// ---------- KV helpers (REST) ----------
function kvEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env missing');
  return { url, token };
}
async function kvGet(key) {
  const { url, token } = kvEnv();
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}?token=${token}`);
  const j = await r.json();
  let v = j?.result ?? null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (_) {} }
  return v;
}
async function kvSet(key, value) {
  const { url, token } = kvEnv();
  const val = typeof value === 'string' ? value : JSON.stringify(value);
  await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}?token=${token}`, { method: 'POST' });
}

// ---------- time helpers ----------
function ymdFromTZ(tz = 'Europe/Belgrade') {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function slotByHour(h){ if(h<12)return'am'; if(h<17)return'pm'; return'late'; }
function detectSlot(tz='Europe/Belgrade'){ const h=Number(new Date(new Date().toLocaleString('en-US',{timeZone:tz})).getHours()); return slotByHour(h); }

export default async function handler(req, res) {
  const tz = 'Europe/Belgrade';
  const ymd = (req.query.ymd || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.ymd : ymdFromTZ(tz);
  const slot = (req.query.slot || '').match(/^(am|pm|late)$/) ? req.query.slot : detectSlot(tz);

  try {
    // --- YOUR EXISTING SNAPSHOT LOGIC RUNS HERE ---
    // It should write:
    //   vb:day:<ymd>:snapshot:index   -> { chunks, size, ... }
    //   vb:day:<ymd>:snapshot:<i>     -> [fixtureIds...]

    // --- union self-heal: ALWAYS write union when snapshot exists ---
    const idxKey = `vb:day:${ymd}:snapshot:index`;
    const idx = await kvGet(idxKey);
    if (idx && Number(idx.chunks) > 0) {
      const chunks = Number(idx.chunks);
      const all = [];
      for (let i = 0; i < chunks; i++) {
        const arr = (await kvGet(`vb:day:${ymd}:snapshot:${i}`)) || [];
        if (Array.isArray(arr) && arr.length) all.push(...arr);
      }
      const union = Array.from(new Set(all));
      await kvSet(`vb:day:${ymd}:union`, union);
    }

    return res.status(200).json({ ok: true, ymd, slot, note: 'rebuild ran; union ensured from snapshot if present' });
  } catch (e) {
    return res.status(200).json({ ok: false, ymd, slot, error: String(e?.message || e) });
  }
}
