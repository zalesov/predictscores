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

async function fetchFixturesForDate(ymd) {
  const key = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY missing');

  let page = 1;
  const ids = [];
  let lastUrl = null;
  // API-FOOTBALL uses paging info: { paging: { current, total } }
  while (true) {
    const path = `/fixtures?from=${ymd}&to=${ymd}&timezone=Europe/Belgrade&page=${page}`;
    lastUrl = `${API_HOST}${path}`;
    let resp;
    try {
      resp = await fetch(lastUrl, { headers: { 'x-apisports-key': key } });
    } catch (err) {
      return {
        ok: false,
        last_url: lastUrl,
        http: { status: null, statusText: 'fetch_error', error: String(err?.message || err) },
      };
    }

    const httpMeta = { status: resp.status, statusText: resp.statusText };
    if (!resp.ok) {
      let body = null;
      try { body = await resp.text(); } catch (_) {}
      return {
        ok: false,
        last_url: lastUrl,
        http: { ...httpMeta, body },
      };
    }

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      return {
        ok: false,
        last_url: lastUrl,
        http: { ...httpMeta, error: 'invalid_json' },
      };
    }

    const arr = Array.isArray(data?.response) ? data.response : [];
    for (const it of arr) {
      const id = it?.fixture?.id;
      if (Number.isInteger(id)) ids.push(id);
    }

    let cur = Number(data?.paging?.current);
    if (!Number.isFinite(cur) || cur <= 0) cur = page;
    let total = Number(data?.paging?.total);
    if (!Number.isFinite(total) || total <= 0) total = cur;
    if (cur >= total) break;
    page = cur + 1;
    // Safety: do not loop forever
    if (page > 50) break;
  }
  return { ok: true, ids: Array.from(new Set(ids)), last_url: lastUrl };
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

  try {
    // 1) Collect fixture IDs for today
    const fixtureResult = await fetchFixturesForDate(ymd);
    if (!fixtureResult?.ok) {
      return res.status(200).json({
        ok: false,
        ymd,
        slot,
        error: 'fixture_fetch_failed',
        last_url: fixtureResult?.last_url || null,
        http: fixtureResult?.http || null,
      });
    }
    const ids = fixtureResult.ids;

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

    const debug = !!req.query.debug;
    return res.status(200).json({
      ok: true, ymd, slot, ts,
      note: 'snapshot+union written',
      size: ids.length,
      chunks: chunks.length,
      ...(debug ? { sample: ids.slice(0, 10) } : {})
    });
  } catch (e) {
    return res.status(200).json({
      ok: false,
      ymd,
      slot,
      error: String(e?.message || e),
      last_url: e?.last_url || null,
      http: e?.http || null,
    });
  }
}
