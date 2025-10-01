// pages/api/cron/rebuild.js
// Collect today's fixtures from API-FOOTBALL and write:
//   vb:day:<ymd>:snapshot:index  -> { ymd, slot, ts, chunks, size }
//   vb:day:<ymd>:snapshot:<i>    -> [fixtureIds...]
//   vb:day:<ymd>:union           -> [fixtureIds...]
// Uses REST KV; no extra deps.

const API_HOST = 'https://v3.football.api-sports.io';

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

function ymdFromTZ(tz = 'Europe/Belgrade') {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function slotByHour(h){ if(h<12)return'am'; if(h<17)return'pm'; return'late'; }
function detectSlot(tz='Europe/Belgrade'){ const h=Number(new Date(new Date().toLocaleString('en-US',{timeZone:tz})).getHours()); return slotByHour(h); }

async function fetchFixturesForDate(ymd, tracker = {}) {
  const key = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY missing');

  let page = 1;
  const ids = [];
  // API-FOOTBALL uses paging info: { paging: { current, total } }
  while (true) {
    const url = `${API_HOST}/fixtures?date=${ymd}&timezone=Europe/Belgrade&page=${page}`;
    tracker.last_url = url;
    const resp = await fetch(url, { headers: { 'x-apisports-key': key } });
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
    // Safety: do not loop forever
    if (page > 50) break;
  }
  return Array.from(new Set(ids)); // de-dup
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

  try {
    // 1) Collect fixture IDs for today
    const ids = await fetchFixturesForDate(ymd, tracker);

    // 2) Write snapshot chunks
    const chunks = chunkArray(ids, 400); // generous chunk size, few KV writes
    for (let i = 0; i < chunks.length; i++) {
      await kvSet(`vb:day:${ymd}:snapshot:${i}`, chunks[i]);
    }

    // 3) Write snapshot index
    await kvSet(`vb:day:${ymd}:snapshot:index`, {
      ymd, slot, ts, chunks: chunks.length, size: ids.length,
    });

    // 4) Write union (de-dup already done)
    await kvSet(`vb:day:${ymd}:union`, ids);
    const union_len = ids.length;

    return res.status(200).json({
      ok: true,
      ymd,
      slot,
      ts,
      size: ids.length,
      chunks: chunks.length,
      union_len,
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
