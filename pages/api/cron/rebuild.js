// pages/api/cron/rebuild.js
// Collect fixtures for Belgrade day; write snapshot chunks, index, union.
// Robust KV + per-slot caps (best-effort). Always writes index/union (even empty).

const API_HOST = 'https://v3.football.api-sports.io';
const API_HINTS = ['api-sports.io','api-football'];
const SLOT_CAPS = { am:2000, pm:3000, late:1000 };

function resolveKV() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env missing');
  return { url, token };
}
async function kvGet(key){
  const { url, token } = resolveKV();
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}?token=${token}`);
    if (r.ok){ const j=await r.json(); let v=j?.result??null; if(typeof v==='string'){try{v=JSON.parse(v);}catch(_){}} return v; }
  } catch(_) {}
  try {
    const r2 = await fetch(`${url}/pipeline`, {
      method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${token}`},
      body: JSON.stringify([['GET', key]]),
    });
    if (r2.ok){ const arr=await r2.json(); let v=arr?.[0]?.result??null; if(typeof v==='string'){try{v=JSON.parse(v);}catch(_){}} return v; }
  } catch(_) {}
  return null;
}
async function kvSetVerified(key, value){
  const { url, token } = resolveKV();
  const val = typeof value==='string'? value : JSON.stringify(value);
  let ok=false;
  try {
    const r = await fetch(`${url}/set`, { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${token}`}, body: JSON.stringify({ key, value: val }) });
    ok=r.ok;
  } catch(_){}
  if(!ok){
    try{
      const r2 = await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}?token=${token}`, { method:'POST' });
      ok=r2.ok;
    }catch(_){}
  }
  if(!ok){
    try{
      const r3 = await fetch(`${url}/pipeline`, { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${token}`}, body: JSON.stringify([['SET', key, val]]) });
      ok=r3.ok;
    }catch(_){}
  }
  if(!ok) throw new Error(`KV_SET_FAILED:${key}`);
  const got = await kvGet(key);
  const exp = typeof value==='string'? value : JSON.parse(val);
  if (JSON.stringify(got)!==JSON.stringify(exp)) throw new Error(`KV_VERIFY_FAILED:${key}`);
  return true;
}

function ymdFromTZ(tz='Europe/Belgrade'){ const d=new Date(new Date().toLocaleString('en-US',{timeZone:tz})); const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; }
function slotByHour(h){ if(h<12)return'am'; if(h<17)return'pm'; return'late'; }
function detectSlot(tz='Europe/Belgrade'){ const h=Number(new Date(new Date().toLocaleString('en-US',{timeZone:tz})).getHours()); return slotByHour(h); }
function spentKey(ymd,slot){ return `afc:spent:${ymd}:${slot}`; }
function capFor(slot){ return SLOT_CAPS[slot]??2000; }

async function countedFetch(url, opts, { ymd, slot }) {
  const u = typeof url==='string'? url : String(url?.url||url);
  const isApi = API_HINTS.some(h => u.includes(h));
  if (!isApi) return fetch(url, opts);
  let spent = 0; try { spent = Number((await kvGet(spentKey(ymd,slot)))||0); } catch(_){}
  if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);
  const resp = await fetch(url, opts);
  try { await kvSetVerified(spentKey(ymd,slot), spent+1); } catch(_) {} // best-effort
  return resp;
}

async function fetchFixturesForDate(ymd, { ymdSlot, tracker }){
  const key = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  if (!key) throw new Error('API_FOOTBALL_KEY missing');
  let page=1; const ids=[];
  while(true){
    const url = `${API_HOST}/fixtures?date=${ymd}&timezone=Europe/Belgrade&page=${page}`;
    tracker.last_url=url;
    const resp = await countedFetch(url, { headers:{ 'x-apisports-key': key } }, ymdSlot);
    tracker.http=resp.status;
    if(!resp.ok) throw new Error(`AF fixtures HTTP ${resp.status}`);
    const data = await resp.json();
    const arr = Array.isArray(data?.response)? data.response : [];
    for(const it of arr){ const id=it?.fixture?.id; if(Number.isInteger(id)) ids.push(id); }
    const cur = Number(data?.paging?.current || page);
    const total = Number(data?.paging?.total || 1);
    if(cur>=total) break;
    page++; if(page>50) break;
  }
  return Array.from(new Set(ids));
}
function chunkArray(a,n){ const out=[]; for(let i=0;i<a.length;i+=n) out.push(a.slice(i,i+n)); return out; }

export default async function handler(req,res){
  const tz='Europe/Belgrade';
  const ymd=(req.query.ymd||'').match(/^\d{4}-\d{2}-\d{2}$/)?req.query.ymd:ymdFromTZ(tz);
  const slot=(req.query.slot||'').match(/^(am|pm|late)$/)?req.query.slot:detectSlot(tz);
  const ts=new Date().toISOString();
  const tracker={ last_url:null, http:null };
  const ymdSlot={ ymd, slot };
  try{
    const ids = await fetchFixturesForDate(ymd, { ymdSlot, tracker });
    const chunks = chunkArray(ids, 350);
    for(let i=0;i<chunks.length;i++){
      await kvSetVerified(`vb:day:${ymd}:snapshot:${i}`, chunks[i]);
    }
    const indexObj={ ymd, slot, ts, chunks:chunks.length, size:ids.length };
    await kvSetVerified(`vb:day:${ymd}:snapshot:index`, indexObj);
    await kvSetVerified(`vb:day:${ymd}:union`, ids);

    return res.status(200).json({ ok:true, ymd, slot, ts, size:ids.length, chunks:chunks.length, union_len:ids.length, sample:ids.slice(0,10) });
  }catch(e){
    return res.status(200).json({ ok:false, ymd, slot, error:String(e?.message||e), last_url:tracker.last_url, http:tracker.http });
  }
}
