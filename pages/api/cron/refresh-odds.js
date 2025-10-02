// pages/api/cron/refresh-odds.js
// Zaključava listu za front (vb-locked:kv:hit) i upisuje meta, uz capove.
// Ne troši dodatne AF pozive za samo zaključenje; oslanja se na vbl_full/union.
// Ako želiš realno osveženje kvota, postojeća logika može ostati – ovo samo
// garantuje da je vb-locked napunjen i meta postavljena.

const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };
const API_HINTS = ['api-sports.io', 'api-football'];

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
async function kvSet(key, value) {
  const val = typeof value === 'string' ? value : JSON.stringify(value);
  await kvPipeline([['SET', key, val]]);
  return true;
}

function ymdFromTZ(tz='Europe/Belgrade'){
  const d = new Date(new Date().toLocaleString('en-US',{ timeZone: tz }));
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function slotByHour(h){ if(h<12)return'am'; if(h<17)return'pm'; return'late'; }
function detectSlot(tz='Europe/Belgrade'){ const h=Number(new Date(new Date().toLocaleString('en-US',{timeZone:tz})).getHours()); return slotByHour(h); }
function spentKey(ymd,slot){ return `afc:spent:${ymd}:${slot}`; }
function capFor(slot){ return SLOT_CAPS[slot] ?? 2000; }

// Ograničenje trošenja za AF pozive; ovo ostavljamo jer možda imaš i real refresh.
// Samo napomena: zaključavanje liste i meta ne koriste AF – KV only.
function installCap(ymd,slot){
  if(global.__fetchCapped) return;
  const orig=global.fetch;
  global.fetch = async (url, opts)=>{
    const u = typeof url==='string'? url : String(url?.url||url);
    if (API_HINTS.some(h=>u.includes(h))){
      let spent = Number((await kvGet(spentKey(ymd,slot)))||0);
      if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);
      const resp = await orig(url, opts);
      try { await kvSet(spentKey(ymd,slot), spent+1); } catch {}
      return resp;
    }
    return orig(url, opts);
  };
  global.__fetchCapped=true;
}

export default async function handler(req,res){
  try{
    const tz='Europe/Belgrade';
    const ymd=(req.query.ymd||'').match(/^\d{4}-\d{2}-\d{2}$/)?req.query.ymd:ymdFromTZ(tz);
    const slot=(req.query.slot||'').match(/^(am|pm|late)$/)?req.query.slot:detectSlot(tz);

    // Kap za AF pozive (ako ovaj handler usput radi i real refresh)
    installCap(ymd,slot);

    // 1) Izvor za zaključavanje: preferiraj vbl_full:<ymd>:<slot>, fallback na union
    const vbl = (await kvGet(`vbl_full:${ymd}:${slot}`)) || [];
    const union = (await kvGet(`vb:day:${ymd}:union`)) || [];
    const pool = Array.isArray(vbl) && vbl.length ? vbl
                : (Array.isArray(union) ? union : []);
    const items = Array.isArray(pool) ? pool.slice(0, 15) : [];

    // 2) Upis zaključane liste + meta (KV-only, 0 AF poziva)
    await kvSet('vb-locked:kv:hit', items);
    const nowIso = new Date().toISOString();
    await kvSet('vb-locked:kv:hit:meta', { ymd, slot, ts: nowIso, last_odds_refresh: nowIso });

    const spent = Number((await kvGet(spentKey(ymd,slot)))||0);
    return res.status(200).json({
      ok:true, ymd, slot,
      cap: capFor(slot), spent,
      note:'refresh-odds (cap enforced) + locked list/meta written from vbl_full/union (KV-only)'
    });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
