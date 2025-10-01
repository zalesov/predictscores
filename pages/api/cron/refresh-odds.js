// pages/api/cron/refresh-odds.js
// Adds strict slot caps and safe empty-union exit (no external deps)

const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };
const API_HOST_HINT = 'api-football';

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
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch(_) {} }
  return v;
}
async function kvSet(key, value) {
  const { url, token } = kvEnv();
  const val = typeof value === 'string' ? value : JSON.stringify(value);
  await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}?token=${token}`, { method: 'POST' });
}

// ---------- time/slot ----------
function ymdFromTZ(tz = 'Europe/Belgrade') {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const yyyy = d.getFullYear(), mm = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}
function slotByHour(h){ if(h<12)return'am'; if(h<17)return'pm'; return'late'; }
function detectSlot(tz='Europe/Belgrade'){ const h=Number(new Date(new Date().toLocaleString('en-US',{timeZone:tz})).getHours()); return slotByHour(h); }
function spentKeyFor(ymd, slot){ return `afc:spent:${ymd}:${slot}`; }

// ---------- guarded API fetch (counts & caps API-FOOTBALL calls) ----------
async function apiFetch(url, opts, { ymd, slot }) {
  // Only count requests to API-FOOTBALL (substring check)
  if (typeof url === 'string' && url.includes(API_HOST_HINT)) {
    const key = spentKeyFor(ymd, slot);
    const cap = SLOT_CAPS[slot] ?? 2000;
    let spent = Number((await kvGet(key)) || 0);
    if (spent >= cap) throw new Error(`CAP_REACHED:${slot}:${spent}/${cap}`);
    const resp = await fetch(url, opts);
    await kvSet(key, ++spent);
    return resp;
  }
  return fetch(url, opts);
}

export default async function handler(req, res) {
  try {
    const tz='Europe/Belgrade';
    const ymd=(req.query.ymd||'').match(/^\d{4}-\d{2}-\d{2}$/)?req.query.ymd:ymdFromTZ(tz);
    const slot=(req.query.slot||'').match(/^(am|pm|late)$/)?req.query.slot:detectSlot(tz);

    // 1) Save calls if nothing to refresh
    const union = (await kvGet(`vb:day:${ymd}:union`)) || [];
    if (!Array.isArray(union) || union.length === 0) {
      return res.status(200).json({ ok:true, ymd, slot, reason:'empty-union', refreshed:0, cap:SLOT_CAPS[slot] });
    }

    // 2) >>> YOUR EXISTING LOGIC <<<:
    // Replace your direct fetch() calls to API-FOOTBALL with apiFetch(..., { ymd, slot })
    // Example:
    // const r = await apiFetch(`https://api-football/v3/odds?...`, { headers: {...} }, { ymd, slot });
    // const data = await r.json();
    // ... rest of your current logic ...

    // If you don't touch anything else, at least return a heartbeat with current counters:
    const spent = Number((await kvGet(spentKeyFor(ymd, slot))) || 0);
    return res.status(200).json({ ok:true, ymd, slot, cap:SLOT_CAPS[slot], spent, note:'refresh-odds ran (cap-enabled)' });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
