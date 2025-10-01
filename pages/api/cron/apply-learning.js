// pages/api/cron/apply-learning.js
// Reads union and writes vbl_full:* in the unified KV

function resolveKV() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('KV env missing');
  return { url, token };
}
async function kvGet(key) {
  const { url, token } = resolveKV();
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}?token=${token}`);
    if (r.ok) {
      const j = await r.json();
      let v = j?.result ?? null;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch(_){} }
      return v;
    }
  } catch(_) {}
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
  const { url, token } = resolveKV();
  const val = typeof value === 'string' ? value : JSON.stringify(value);
  let ok=false;
  try {
    const r = await fetch(`${url}/set`, {
      method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${token}`},
      body: JSON.stringify({ key, value: val }),
    });
    ok = r.ok;
  } catch(_){}
  if (!ok) {
    try {
      const r2 = await fetch(`${url}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}?token=${token}`, { method:'POST' });
      ok = r2.ok;
    } catch(_){}
  }
  if (!ok) {
    try {
      const r3 = await fetch(`${url}/pipeline`, {
        method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${token}`},
        body: JSON.stringify([['SET', key, val]]),
      });
      ok = r3.ok;
    } catch(_){}
  }
  if (!ok) throw new Error(`KV_SET_FAILED:${key}`);
  const got = await kvGet(key);
  const exp = typeof value==='string'? value : JSON.parse(val);
  if (JSON.stringify(got)!==JSON.stringify(exp)) throw new Error(`KV_VERIFY_FAILED:${key}`);
  return true;
}

function ymdFromTZ(tz='Europe/Belgrade'){
  const d=new Date(new Date().toLocaleString('en-US',{timeZone:tz}));
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
function slotByHour(h){ if(h<12)return'am'; if(h<17)return'pm'; return'late'; }
function detectSlot(tz='Europe/Belgrade'){ const h=Number(new Date(new Date().toLocaleString('en-US',{timeZone:tz})).getHours()); return slotByHour(h); }

export default async function handler(req,res){
  try{
    const tz='Europe/Belgrade';
    const ymd=(req.query.ymd||'').match(/^\d{4}-\d{2}-\d{2}$/)?req.query.ymd:ymdFromTZ(tz);
    const slot=(req.query.slot||'').match(/^(am|pm|late)$/)?req.query.slot:detectSlot(tz);

    const sourceKey=`vb:day:${ymd}:union`;
    const union=(await kvGet(sourceKey))||[];
    const items=Array.isArray(union)?union:[];
    const vblSlotKey=`vbl_full:${ymd}:${slot}`;
    const vblDayKey=`vbl_full:${ymd}`;
    const historyKey=`vb:history:${ymd}`;
    const lockKey=`vb:day:${ymd}:last`;
    const vbHit='vb-locked:kv:hit';
    const vbHitDay=`${vbHit}:${ymd}`;

    // Your existing scoring/learning can sit here; we just forward the union for now:
    await kvSetVerified(vblSlotKey, items);
    await kvSetVerified(vblDayKey, items);
    await kvSetVerified(lockKey, items);
    await kvSetVerified(historyKey, { ymd, slot, count: items.length, ts: new Date().toISOString() });
    await kvSetVerified(vbHit, true);
    await kvSetVerified(vbHitDay, true);

    return res.status(200).json({ ok:true, ymd, slot, count: items.length, wrote: { vblSlotKey, vblDayKey, historyKey, lockKey, vbHitDay, vbHit }, sourceKey });
  }catch(e){
    return res.status(200).json({ ok:false, error:String(e?.message||e) });
  }
}
