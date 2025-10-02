// pages/api/value-bets-locked.js
// Vraća zaključanu listu za UI. Kad je slim=1, items su OBJEKTI { id } da UI ne renderuje praznu karticu.
// Fallback: ako vb-locked nema stavke, koristi vbl_full:<ymd>:<slot> (prvih 15).
// KV-only (bez API-Football poziva).

function resolveKV() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env missing');
  return { url, token };
}
async function kvPipeline(cmds) {
  const { url, token } = resolveKV();
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`KV_PIPELINE_HTTP_${r.status}`);
  return r.json();
}
async function kvGet(key) {
  try {
    const arr = await kvPipeline([['GET', key]]);
    let v = arr?.[0]?.result ?? null;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
    return v;
  } catch {
    return null;
  }
}

function ymdFromTZ(tz='Europe/Belgrade'){
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function slotByHour(h){ if(h<12)return'am'; if(h<17)return'pm'; return'late'; }
function detectSlot(tz='Europe/Belgrade'){
  const h = Number(new Date(new Date().toLocaleString('en-US',{ timeZone: tz })).getHours());
  return slotByHour(h);
}

export default async function handler(req, res) {
  try {
    const tz = 'Europe/Belgrade';
    const ymd = (req.query.ymd||'').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.ymd : ymdFromTZ(tz);
    const slot = (req.query.slot||'').match(/^(am|pm|late)$/) ? req.query.slot : detectSlot(tz);
    const slim = String(req.query.slim||'0') === '1';

    // 1) Učitaj zaključanu listu
    let locked = (await kvGet('vb-locked:kv:hit')) || [];

    // 2) Fallback na vbl_full:<ymd>:<slot> ako zaključana lista nije tu
    if (!Array.isArray(locked) || locked.length === 0) {
      const vbl = (await kvGet(`vbl_full:${ymd}:${slot}`)) || [];
      locked = Array.isArray(vbl) ? vbl.slice(0, 15) : [];
    }

    // 3) Meta – realna ako postoji, inače synth "now"
    const metaRaw = (await kvGet('vb-locked:kv:hit:meta')) || null;
    const nowIso = new Date().toISOString();
    const meta = {
      ymd,
      slot,
      source: 'vb-locked:kv:hit',
      ts: metaRaw?.ts || nowIso,
      last_odds_refresh: metaRaw?.last_odds_refresh || nowIso,
      returned: Array.isArray(locked) ? Math.min(locked.length, 15) : 0,
      cap: 15,
    };

    // 4) Slim=1 → vrati OBJEKTE { id } (UI kompatibilnost); bez slim → sirovi ID-evi
    let items;
    if (slim) {
      const ids = Array.isArray(locked) ? locked.slice(0, 15) : [];
      items = ids.map(id => ({ id }));
    } else {
      items = Array.isArray(locked) ? locked : [];
    }

    return res.status(200).json({ items, meta });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
