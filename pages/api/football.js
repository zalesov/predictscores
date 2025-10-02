// pages/api/football.js
// Kompatibilni endpoint za UI.
// - legacy (bez slim=1): vraća IDs iz vbl_full (kao do sada).
// - slim=1: vraća PROŠIRENE stavke [{ id, home, away, league, kickoff }] do 15 kom.
//   Izvor liste: vb-locked:kv:hit -> fallback vbl_full:<ymd>:<slot>.
//   Expand je cap-guarded (AM<=2000 / PM<=3000 / LATE<=1000). Filtrira "prazne" zapise.
//
// Ne diramo ostale rute. Ovo je 1:1 zamena koja omogućava da UI odmah dobije podatke koje očekuje.

const API_HOST = 'https://v3.football.api-sports.io';
const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };
const API_HINTS = ['api-sports.io', 'api-football'];

/* ---------- KV helpers (Upstash pipeline + Bearer) ---------- */
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
  } catch { return null; }
}

/* ---------- vreme/slot + caps ---------- */
function ymdFromTZ(tz='Europe/Belgrade'){
  const d = new Date(new Date().toLocaleString('en-US',{ timeZone: tz }));
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), dd = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function slotByHour(h){ if(h<12)return'am'; if(h<17)return'pm'; return'late'; }
function detectSlot(tz='Europe/Belgrade'){
  const h = Number(new Date(new Date().toLocaleString('en-US',{ timeZone: tz })).getHours());
  return slotByHour(h);
}
function spentKey(ymd,slot){ return `afc:spent:${ymd}:${slot}`; }
function capFor(slot){ return SLOT_CAPS[slot] ?? 2000; }

/* ---------- cap-aware AF fetch (best-effort counter) ---------- */
async function countedAF(url, opts, ymd, slot) {
  const u = typeof url==='string' ? url : String(url?.url||url);
  if (!API_HINTS.some(h=>u.includes(h))) return fetch(url, opts);
  let spent = Number((await kvGet(spentKey(ymd,slot)))||0);
  if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);
  const resp = await fetch(url, opts);
  try { await kvPipeline([['SET', spentKey(ymd,slot), String(spent+1) ]]); } catch {}
  return resp;
}

/* ---------- expand helpers ---------- */
async function expandOne(id, { ymd, slot, apiKey }) {
  const url = `${API_HOST}/fixtures?id=${id}&timezone=Europe/Belgrade`;
  const r = await countedAF(url, { headers: { 'x-apisports-key': apiKey, 'accept': 'application/json' } }, ymd, slot);
  const data = await r.json();
  if (data?.errors && Object.keys(data.errors).length > 0) return null;
  const row = Array.isArray(data?.response) ? data.response[0] : null;
  if (!row) return null;
  return {
    id,
    home: row?.teams?.home?.name || null,
    away: row?.teams?.away?.name || null,
    league: row?.league?.name || null,
    kickoff: row?.fixture?.date || null,
  };
}

async function expandList(ids, { ymd, slot }) {
  const keyRaw = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  const apiKey = (keyRaw||'').trim();
  if (!apiKey) return [];
  const tasks = ids.slice(0,15).map(id => expandOne(id, { ymd, slot, apiKey }).catch(()=>null));
  const out = (await Promise.all(tasks)).filter(Boolean);
  // Filtriraj "prazne" gde nema home/away/kickoff
  return out.filter(x => x && x.home && x.away && x.kickoff);
}

/* ---------- main handler ---------- */
export default async function handler(req, res) {
  try {
    const tz='Europe/Belgrade';
    const ymd = (req.query.ymd||'').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.ymd : ymdFromTZ(tz);
    const slot = (req.query.slot||'').match(/^(am|pm|late)$/) ? req.query.slot : detectSlot(tz);
    const slim = String(req.query.slim||'0') === '1';

    if (slim) {
      // 1) locked -> fallback vbl_full
      let locked = (await kvGet('vb-locked:kv:hit')) || [];
      if (!Array.isArray(locked) || locked.length===0) {
        const vbl = (await kvGet(`vbl_full:${ymd}:${slot}`)) || [];
        locked = Array.isArray(vbl) ? vbl.slice(0,15) : [];
      }
      const ids = Array.isArray(locked) ? locked.slice(0,15) : [];

      // 2) expand (cap-guarded) i filtriraj prazne
      let games = [];
      try { games = await expandList(ids, { ymd, slot }); } catch { games = []; }

      return res.status(200).json({
        ok: true,
        ymd, slot,
        count: games.length,
        items: games,            // PROŠIRENO za UI
        ids,                     // za svaki slučaj
        key: `vbl_full:${ymd}:${slot}`
      });
    }

    // legacy režim: vrati IDs iz vbl_full (kao ranije)
    const vbl = (await kvGet(`vbl_full:${ymd}:${slot}`)) || [];
    const ids = Array.isArray(vbl) ? vbl : [];
    return res.status(200).json({
      ok: true,
      ymd, slot,
      count: ids.length,
      key: `vbl_full:${ymd}:${slot}`,
      items: ids
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message||e) });
  }
}
