// pages/api/cron/refresh-odds.js
// REST-based KV + strict slot caps + safe empty-union exit

const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };
const API_HOST_HINT = 'api-football';

// ---- KV (REST) ----
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

// ---- time/slot ----
function ymdFromTZ(tz = 'Europe/Belgrade') {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function getSlotByHour(h) { if (h < 12) return 'am'; if (h < 17) return 'pm'; return 'late'; }
function detectSlot(tz = 'Europe/Belgrade') {
  const h = Number(new Date(new Date().toLocaleString('en-US', { timeZone: tz })).getHours());
  return getSlotByHour(h);
}
function counterKey(ymd, slot) { return `afc:spent:${ymd}:${slot}`; }
async function readSpent(ymd, slot) { return Number((await kvGet(counterKey(ymd, slot))) || 0); }
async function addSpent(ymd, slot, delta) {
  const cur = Number((await kvGet(counterKey(ymd, slot))) || 0);
  await kvSet(counterKey(ymd, slot), cur + delta);
  return cur + delta;
}
function capFor(slot) { return SLOT_CAPS[slot] ?? 2000; }

// ---- fetch cap ----
function installFetchCap(ymd, slot) {
  if (global.__fetchCapped) return;
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    const u = typeof url === 'string' ? url : String(url?.url || url);
    if (u.includes(API_HOST_HINT)) {
      const spent = await readSpent(ymd, slot);
      if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);
      const resp = await orig(url, opts);
      await addSpent(ymd, slot, 1);
      return resp;
    }
    return orig(url, opts);
  };
  global.__fetchCapped = true;
}

export default async function handler(req, res) {
  const tz = 'Europe/Belgrade';
  const ymd = (req.query.ymd || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.ymd : ymdFromTZ(tz);
  const slot = (req.query.slot || '').match(/^(am|pm|late)$/) ? req.query.slot : detectSlot(tz);

  installFetchCap(ymd, slot);

  try {
    const union = (await kvGet(`vb:day:${ymd}:union`)) || [];
    if (!Array.isArray(union) || union.length === 0) {
      return res
        .status(200)
        .json({ ok: true, ymd, slot, reason: 'empty-union', refreshed: 0, cap: capFor(slot), spent: await readSpent(ymd, slot) });
    }

    // ---- your existing refresh-odds logic stays here; all API-FOOTBALL fetches are capped ----

    const spent = await readSpent(ymd, slot);
    return res.status(200).json({ ok: true, ymd, slot, cap: capFor(slot), spent, note: 'refresh-odds completed (guarded)' });
  } catch (e) {
    return res.status(200).json({ ok: false, ymd, slot, error: String(e?.message || e) });
  }
}
