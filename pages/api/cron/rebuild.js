// pages/api/cron/rebuild.js
// Collect today's fixtures from API-FOOTBALL and write:
//   vb:day:<ymd>:snapshot:index  -> { ymd, slot, ts, chunks, size }
//   vb:day:<ymd>:snapshot:<i>    -> [fixtureIds...]
//   vb:day:<ymd>:union           -> [fixtureIds...]
// Uses REST KV; verifies writes; enforces slot caps on API-FOOTBALL calls.

const API_HOST = 'https://v3.football.api-sports.io';

// --- Slot caps (API-FOOTBALL calls) ---
const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };
const API_HOST_HINT = 'api-sports.io'; // count any API-FOOTBALL call

// ---------- KV helpers (REST, with verification) ----------
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
async function kvSetVerified(key, value) {
  // Try path-style SET first
  const { url, token } = kvEnv();
  const val = typeof value === 'string' ? value : JSON.stringify(value);

  let ok = false;
  try {
    const r1 = await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}?token=${token}`, { method: 'POST' });
    ok = r1.ok;
  } catch (_) { /* fall back below */ }

  // Fallback: JSON body SET (works on all Upstash plans/regions)
  if (!ok) {
    const r2 = await fetch(`${url}/set?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, value: val })
    });
    ok = r2.ok;
  }

  if (!ok) throw new Error(`KV_SET_FAILED:${key}`);

  // Verify
  const got = await kvGet(key);
  const expected = typeof value === 'string' ? value : JSON.parse(val);
  const eq = JSON.stringify(got) === JSON.stringify(expected);
  if (!eq) throw new Error(`KV_VERIFY_FAILED:${key}`);
  return true;
}

// ---------- time/slot helpers ----------
function ymdFromTZ(tz = 'Europe/Belgrade') {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function slotByHour(h){ if(h<12)return'am'; if(h<17)return'pm'; return'late'; }
function detectSlot(tz='Europe/Belgrade'){
  const h = Number(new Date(new Date().toLocaleString('en-US',{timeZone:tz})).getHours());
  return slotByHour(h);
}
function spentKey(ymd, slot){ return `afc:spent:${ymd}:${slot}`; }
async function readSpent(ymd, slot){ return Number((await kvGet(spentKey(ymd,slot))) || 0); }
async function addSpent(ymd, slot, delta){ const k=spentKey(ymd,slot); const cur=Number((await kvGet(k))||0); await kvSetVerified(k, cur+delta); return cur+delta; }
function capFor(slot){ return SLOT_CAPS[slot] ?? 2000; }

// ---------- Cap-aware fetch (counts API-FOOTBALL calls) ----------
async function apiFetch(url, opts, { ymd, slot }) {
  const u = typeof url === 'string' ? url : String(url?.url || url);
  if (u.includes(API_HOST_HINT)) {
    const spent = await readSpent(ymd, slot);
    if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);
    const resp = await fetch(url, opts);
    await addSpent(ymd, slot, 1);
    return resp;
  }
  return fetch(url, opts);
}

// ---------- collector ----------
async function fetchFixturesForDate(ymd, { ymdSlot, tracker }) {
  const key = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY missing');

  // Use from/to range (same day) with explicit timezone to avoid empty "date=" edge cases.
  let page = 1;
  const ids = [];
  while (true) {
    const url = `${API_HOST}/fixtures?from=${ymd}&to=${ymd}&timezone=Europe/Belgrade&page=${page}`;
    tracker.last_url = url;
    const resp = await apiFetch(url, { headers: { 'x-apisports-key': key } }, ymdSlot);
    tracker.http = resp.status;
    if (!resp.ok) throw new Error(`AF fixtures HTTP ${resp.status}`);
    const data = await resp.json();

    const arr = Array.isArray(data?.response) ? data.response : [];
    for (const it of arr) {
      const id = it?.fixture?.id;
      if (Number.isInteger(id)) ids.push(id);
    }

    const cur = Number(data?.paging?.current || page);
    const total = Number(data?.paging?.total || 1);
    if (cur >= total) break;
    page++;
    if (page > 50) break; // safety
  }
  return Array.from(new Set(ids));
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default async function handler(req, res) {
  const tz = 'Europe/Belgrade';
  const ymd = (req.query.ymd || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.ymd : ymdFromTZ(tz);
  const slot = (req.query.slot || '').match(/^(am|pm|late)$/) ? req.query.slot : detectSlot(tz);
  const ts = new Date().toISOString();
  const tracker = { last_url: null, http: null };
  const ymdSlot = { ymd, slot };

  try {
    // 1) Collect fixture IDs for today
    const ids = await fetchFixturesForDate(ymd, { ymdSlot, tracker });

    // 2) Write snapshot chunks (even if empty, we still write index + union)
    const chunks = chunkArray(ids, 350);
    for (let i = 0; i < chunks.length; i++) {
      await kvSetVerified(`vb:day:${ymd}:snapshot:${i}`, chunks[i]);
    }

    // 3) Write snapshot index
    const indexObj = { ymd, slot, ts, chunks: chunks.length, size: ids.length };
    await kvSetVerified(`vb:day:${ymd}:snapshot:index`, indexObj);

    // 4) Write union
    await kvSetVerified(`vb:day:${ymd}:union`, ids);

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      ts,
      size: ids.length,
      chunks: chunks.length,
      union_len: ids.length,
      sample: ids.slice(0, 10),
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      ymd,
      slot,
      error: String(e?.message || e),
      last_url: tracker.last_url,
      http: tracker.http,
    });
  }
}
