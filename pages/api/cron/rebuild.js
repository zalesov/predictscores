// pages/api/cron/rebuild.js
// Snapshot kolektor za današnji (YMD) Belgrade dan:
// - čita fixturе iz API-FOOTBALL preko ?date=<YMD>&timezone=Europe/Belgrade&page=n
// - striktno detektuje API greške (i kad vraća 200 sa errors.token)
// - UVEK upisuje snapshot:index i union kad je uspešno (čak i kad je lista prazna)
// - Poštuje per-slot capove: AM=2000, PM=3000, LATE=1000 (brojač best-effort)
// - Jedinstveni KV klijent (Upstash /pipeline + Bearer), verifikacija posle SET-a

const API_HOST = 'https://v3.football.api-sports.io';
const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };
const API_HINTS = ['api-sports.io', 'api-football'];

/* ---------- Jedinstveni KV klijent (pipeline + Bearer) ---------- */
function kvResolve() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env missing');
  return { url, token };
}

async function kvPipeline(cmds) {
  const { url, token } = kvResolve();
  const r = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error(`KV_PIPELINE_HTTP_${r.status}`);
  return r.json(); // array of { result: ... }
}

async function kvGet(key) {
  try {
    const arr = await kvPipeline([['GET', key]]);
    let v = arr?.[0]?.result ?? null;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep raw */ } }
    return v;
  } catch {
    return null;
  }
}

async function kvSetVerified(key, value) {
  const valStr = typeof value === 'string' ? value : JSON.stringify(value);
  const arr = await kvPipeline([['SET', key, valStr]]);
  if (!arr?.[0]) throw new Error(`KV_SET_FAILED:${key}`);
  const got = await kvGet(key);
  const expected = typeof value === 'string' ? value : JSON.parse(valStr);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`KV_VERIFY_FAILED:${key}`);
  }
  return true;
}

/* ---------- vreme/slot ---------- */
function ymdFromTZ(tz = 'Europe/Belgrade') {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function slotByHour(h){ if(h<12) return 'am'; if(h<17) return 'pm'; return 'late'; }
function detectSlot(tz='Europe/Belgrade'){
  const h = Number(new Date(new Date().toLocaleString('en-US',{ timeZone: tz })).getHours());
  return slotByHour(h);
}
function spentKey(ymd, slot){ return `afc:spent:${ymd}:${slot}`; }
function capFor(slot){ return SLOT_CAPS[slot] ?? 2000; }

/* ---------- cap-aware fetch (ne ruši run ako upis brojača omane) ---------- */
async function countedFetch(url, opts, { ymd, slot }) {
  const u = typeof url === 'string' ? url : String(url?.url || url);
  const isApi = API_HINTS.some(h => u.includes(h));
  if (!isApi) return fetch(url, opts);

  let spent = Number((await kvGet(spentKey(ymd, slot))) || 0);
  if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);

  const resp = await fetch(url, opts);

  // best-effort inkrement – i ako KV ne primi, ne blokiramo kolektor
  try { await kvSetVerified(spentKey(ymd, slot), spent + 1); } catch {}
  return resp;
}

/* ---------- kolektor fixtura (sa eksplicitnom detekcijom API errors) ---------- */
async function fetchFixturesForDate(ymd, { ymd: y, slot }, tracker) {
  const keyRaw = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  const key = (keyRaw || '').trim();
  if (!key) throw new Error('API_FOOTBALL_KEY missing');

  let page = 1;
  const ids = [];
  while (true) {
    const url = `${API_HOST}/fixtures?date=${ymd}&timezone=Europe/Belgrade&page=${page}`;
    tracker.last_url = url;

    const resp = await countedFetch(
      url,
      {
        method: 'GET',
        headers: {
          'x-apisports-key': key,         // <— OBAVEZNO: header sa ključem
          'accept': 'application/json'
        },
        cache: 'no-store'
      },
      { ymd: y, slot }
    );

    tracker.http = resp.status;
    const data = await resp.json();

    // --- DETEKCIJA API "errors" (često vraća 200 sa errors.token) ---
    if (data?.errors && Object.keys(data.errors).length > 0) {
      const errMsg = Object.entries(data.errors)
        .map(([k, v]) => `${k}:${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('; ');
      throw new Error(`AF_ERRORS:${errMsg}`);
    }

    // defensive: očekujemo niz
    if (!Array.isArray(data?.response)) {
      throw new Error(`AF_SHAPE: response_not_array (${JSON.stringify(data).slice(0,160)}...)`);
    }

    for (const it of data.response) {
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

function chunkArray(arr, n) { const out=[]; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i, i+n)); return out; }

/* ---------- handler ---------- */
export default async function handler(req, res) {
  const tz = 'Europe/Belgrade';
  const ymd = (req.query.ymd || '').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.ymd : ymdFromTZ(tz);
  const slot = (req.query.slot || '').match(/^(am|pm|late)$/) ? req.query.slot : detectSlot(tz);
  const ts = new Date().toISOString();
  const tracker = { last_url: null, http: null };
  const ymdSlot = { ymd, slot };

  try {
    // 1) pokupi fixturе ID-eve
    const ids = await fetchFixturesForDate(ymd, ymdSlot, tracker);

    // 2) UVEK upiši index i union (čak i kad je prazno)
    const chunks = chunkArray(ids, 350);
    for (let i = 0; i < chunks.length; i++) {
      await kvSetVerified(`vb:day:${ymd}:snapshot:${i}`, chunks[i]);
    }
    const indexObj = { ymd, slot, ts, chunks: chunks.length, size: ids.length };
    await kvSetVerified(`vb:day:${ymd}:snapshot:index`, indexObj);
    await kvSetVerified(`vb:day:${ymd}:union`, ids);

    // gotov
    return res.status(200).json({
      ok: true,
      ymd, slot, ts,
      size: ids.length,
      chunks: chunks.length,
      union_len: ids.length,
      sample: ids.slice(0, 10),
    });
  } catch (e) {
    // NEMA lažnog ok:true kad je token/shape problem: jasno prijavi grešku
    return res.status(200).json({
      ok: false,
      ymd, slot,
      error: String(e?.message || e),
      last_url: tracker.last_url,
      http: tracker.http,
    });
  }
}
