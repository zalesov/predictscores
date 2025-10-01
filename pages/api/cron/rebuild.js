// pages/api/cron/rebuild.js
// Builds today's snapshot and union from API-FOOTBALL and stores them in KV.
// Writes (always, even if empty):
//   vb:day:<ymd>:snapshot:index  -> { ymd, slot, ts, chunks, size }
//   vb:day:<ymd>:snapshot:<i>    -> [fixtureIds...]
//   vb:day:<ymd>:union           -> [fixtureIds...]
//
// Fixes:
// - Uses the working query: ?date=<YMD>&timezone=Europe/Belgrade&page=<n>
// - Robust KV writes (path, JSON, pipeline; Authorization + token) with verification
// - Per-slot API call ceilings (AM=2000, PM=3000, LATE=1000) with best-effort counter

const API_HOST = 'https://v3.football.api-sports.io';
const API_HINTS = ['api-sports.io', 'api-football'];

// ---- Slot caps ----
const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };

// ---------- KV helpers (robust) ----------
function kvEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env missing');
  return { url, token };
}

async function kvGet(key) {
  const { url, token } = kvEnv();

  // 1) Path GET with token query
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}?token=${token}`);
    if (r.ok) {
      const j = await r.json();
      let v = j?.result ?? null;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch(_){} }
      return v;
    }
  } catch(_) {}

  // 2) Pipeline GET with Authorization header
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
  } catch(_) {}

  return null;
}

async function kvSetVerified(key, value) {
  const { url, token } = kvEnv();
  const val = typeof value === 'string' ? value : JSON.stringify(value);

  let ok = false;

  // 1) JSON body /set with Authorization header
  try {
    const r = await fetch(`${url}/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
      body: JSON.stringify({ key, value: val }),
    });
    ok = r.ok;
  } catch(_) {}

  // 2) Path-style SET with token query
  if (!ok) {
    try {
      const r2 = await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}?token=${token}`, { method: 'POST' });
      ok = r2.ok;
    } catch(_) {}
  }

  // 3) Pipeline SET with Authorization header
  if (!ok) {
    try {
      const r3 = await fetch(`${url}/pipeline`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
        body: JSON.stringify([['SET', key, val]]),
      });
      ok = r3.ok;
    } catch(_) {}
  }

  if (!ok) throw new Error(`KV_SET_FAILED:${key}`);

  // Verify
  const got = await kvGet(key);
  const expected = typeof value === 'string' ? value : JSON.parse(val);
  const eq = JSON.stringify(got) === JSON.stringify(expected);
  if (!eq) throw new Error(`KV_VERIFY_FAILED:${key}`);
  return true;
}

// ---------- time & slot ----------
function ymdFromTZ(tz = 'Europe/Belgrade') {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function slotByHour(h){ if (h < 12) return 'am'; if (h < 17) return 'pm'; return 'late'; }
function detectSlot(tz='Europe/Belgrade'){
  const h = Number(new Date(new Date().toLocaleString('en-US',{ timeZone: tz })).getHours());
  return slotByHour(h);
}

// ---------- per-slot cap counter (best-effort) ----------
function spentKey(ymd, slot){ return `afc:spent:${ymd}:${slot}`; }
function capFor(slot){ return SLOT_CAPS[slot] ?? 2000; }

async function countedFetch(url, opts, { ymd, slot }) {
  const u = typeof url === 'string' ? url : String(url?.url || url);
  const isApi = API_HINTS.some(h => u.includes(h));
  if (!isApi) return fetch(url, opts);

  // Read current spent (best-effort)
  let spent = 0;
  try { spent = Number((await kvGet(spentKey(ymd, slot))) || 0); } catch(_) {}
  if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);

  const resp = await fetch(url, opts);

  // Increment (best-effort; do not brick run if KV hiccups)
  try { await kvSetVerified(spentKey(ymd, slot), spent + 1); } catch(_) {}
  return resp;
}

// ---------- collector ----------
async function fetchFixturesForDate(ymd, { ymdSlot, tracker }) {
  const key = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY missing');

  let page = 1;
  const ids = [];
  while (true) {
    const url = `${API_HOST}/fixtures?date=${ymd}&timezone=Europe/Belgrade&page=${page}`;
    tracker.last_url = url;
    const resp = await countedFetch(url, { headers: { 'x-apisports-key': key } }, ymdSlot);
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
    // 1) Collect fixture IDs for today (Europe/Belgrade)
    const ids = await fetchFixturesForDate(ymd, { ymdSlot, tracker });

    // 2) Write snapshot chunks (even if empty)
    const chunks = chunkArray(ids, 350);
    for (let i = 0; i < chunks.length; i++) {
      await kvSetVerified(`vb:day:${ymd}:snapshot:${i}`, chunks[i]);
    }

    // 3) Write snapshot index (always)
    const indexObj = { ymd, slot, ts, chunks: chunks.length, size: ids.length };
    await kvSetVerified(`vb:day:${ymd}:snapshot:index`, indexObj);

    // 4) Write union (always)
    await kvSetVerified(`vb:day:${ymd}:union`, ids);

    // Done
    return res.status(200).json({
      ok: true,
      ymd, slot, ts,
      size: ids.length,
      chunks: chunks.length,
      union_len: ids.length,
      sample: ids.slice(0, 10),
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      ymd, slot,
      error: String(e?.message || e),
      last_url: tracker.last_url,
      http: tracker.http,
    });
  }
}
