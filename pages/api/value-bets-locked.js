// pages/api/value-bets-locked.js
// Locked feed za UI.
// Promena: kad je ?slim=1, sada AUTOMATSKI vraća objekte { id, home, away, league, kickoff }.
// Ako AF poziv ne uspe ili cap udari, vrati fallback { id } (da UI barem nešto renderuje).
// Fallback izvora liste: vb-locked:kv:hit -> vbl_full:<ymd>:<slot>. KV-only za listu; AF samo za expand (max 15).

const API_HOST = 'https://v3.football.api-sports.io';
const SLOT_CAPS = { am:2000, pm:3000, late:1000 };
const API_HINTS = ['api-sports.io','api-football'];

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
    headers: { 'content-type':'application/json', authorization: `Bearer ${token}` },
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
  const d=new Date(new Date().toLocaleString('en-US',{ timeZone: tz }));
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function slotByHour(h){ if(h<12)return'am'; if(h<17)return'pm'; return'late'; }
function detectSlot(tz='Europe/Belgrade'){
  const h=Number(new Date(new Date().toLocaleString('en-US',{timeZone:tz})).getHours());
  return slotByHour(h);
}
function spentKey(ymd,slot){ return `afc:spent:${ymd}:${slot}`; }
function capFor(slot){ return SLOT_CAPS[slot] ?? 2000; }

/* ---------- cap-aware fetch za AF (inkrement best-effort) ---------- */
async function countedAF(url, opts, ymd, slot) {
  const u = typeof url==='string' ? url : String(url?.url||url);
  if (!API_HINTS.some(h=>u.includes(h))) return fetch(url, opts);

  let spent = Number((await kvGet(spentKey(ymd,slot)))||0);
  if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);
  const resp = await fetch(url, opts);
  try { await kvPipeline([['SET', spentKey(ymd,slot), String(spent+1) ]]); } catch {}
  return resp;
}

/* ---------- expand iz API-FOOTBALL (max 15 id-eva) ---------- */
async function expandFixtures(ids, { ymd, slot }) {
  const keyRaw = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  const apiKey = (keyRaw||'').trim();
  if (!apiKey || !Array.isArray(ids) || ids.length===0) return [];

  const out = [];
  for (const id of ids) {
    try {
      const url = `${API_HOST}/fixtures?id=${id}&timezone=Europe/Belgrade`;
      const r = await countedAF(url, { headers:{ 'x-apisports-key': apiKey, 'accept':'application/json' } }, ymd, slot);
      const data = await r.json();

      // detektuj "errors" i preskoči taj id
      if (data?.errors && Object.keys(data.errors).length>0) continue;

      const row = Array.isArray(data?.response) ? data.response[0] : null;
      const home = row?.teams?.home?.name || null;
      const away = row?.teams?.away?.name || null;
      const league = row?.league?.name || null;
      const kickoff = row?.fixture?.date || null;

      out.push({ id, home, away, league, kickoff });
      if (out.length >= 15) break;
    } catch {
      // na bilo koju grešku, preskoči ovaj id
      continue;
    }
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const tz = 'Europe/Belgrade';
    const ymd = (req.query.ymd||'').match(/^\d{4}-\d{2}-\d{2}$/) ? req.query.ymd : ymdFromTZ(tz);
    const slot = (req.query.slot||'').match(/^(am|pm|late)$/) ? req.query.slot : detectSlot(tz);
    const slim = String(req.query.slim||'0') === '1';
    const expand = String(req.query.expand||'0') === '1';

    // 1) Locked lista ili fallback na vbl_full
    let locked = (await kvGet('vb-locked:kv:hit')) || [];
    if (!Array.isArray(locked) || locked.length===0) {
      const vbl = (await kvGet(`vbl_full:${ymd}:${slot}`)) || [];
      locked = Array.isArray(vbl) ? vbl.slice(0, 15) : [];
    }
    const ids = Array.isArray(locked) ? locked.slice(0, 15) : [];

    // 2) Meta (realna ili synth)
    const metaRaw = (await kvGet('vb-locked:kv:hit:meta')) || null;
    const nowIso = new Date().toISOString();
    const meta = {
      ymd, slot,
      source: 'vb-locked:kv:hit',
      ts: metaRaw?.ts || nowIso,
      last_odds_refresh: metaRaw?.last_odds_refresh || nowIso,
      returned: ids.length,
      cap: 15,
    };

    // 3) Items
    let items;

    if (slim) {
      // AUTO-EXPAND ZA SLIM: pokušaj da dovučeš minimalna polja;
      // ako ne uspe (cap/errors), vrati fallback { id }.
      let rich = [];
      let expandFailed = false;
      try { rich = await expandFixtures(ids, { ymd, slot }); }
      catch { expandFailed = true; }

      if (!expandFailed && Array.isArray(rich) && rich.length > 0) {
        items = rich.map(x => ({ id: x.id, home: x.home, away: x.away, league: x.league, kickoff: x.kickoff }));
        meta.returned = items.length;
      } else {
        items = ids.map(id => ({ id })); // fallback — barem neće biti prazna kartica
        meta.returned = items.length;
      }
    } else {
      // Legacy ponašanje kad slim nije 1
      if (expand) {
        const rich = await expandFixtures(ids, { ymd, slot });
        items = rich;
        meta.returned = Array.isArray(rich) ? rich.length : 0;
      } else {
        items = ids; // niz ID-eva
      }
    }

    return res.status(200).json({ items, meta });
  } catch (e) {
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
