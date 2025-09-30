// pages/api/cron/rebuild.js
// REST-based KV + strict slot caps + union self-heal

// ---- Slot caps for API-FOOTBALL ----
const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };
const API_HOST_HINT = 'api-football'; // substring check on URL

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
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}?token=${token}`, { method: 'POST' });
  return r.ok;
}

// ---------- time/slot helpers ----------
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

// --------- fetch cap (monkey-patch) ----------
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

  installFetchCap(ymd, slot); // enforce caps on any API-FOOTBALL calls made here

  try {
    // --- Your existing snapshot logic runs here (unchanged) ---
    // It should write:
    //   vb:day:<ymd>:snapshot:index  -> {chunks, size, ...}
    //   vb:day:<ymd>:snapshot:<i>    -> [fixtureIds...]

    // --- ALWAYS (re)write union if snapshot exists ---
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

    const spent = await readSpent(ymd, slot);
    return res.status(200).json({ ok: true, ymd, slot, cap: capFor(slot), spent, note: 'rebuild ran; union ensured' });
  } catch (e) {
    return res.status(200).json({ ok: false, ymd, slot, error: String(e?.message || e) });
  }
}
