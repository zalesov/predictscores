// pages/api/cron/apply-learning.js
// Formira vbl_full:<YMD>:<slot> i vbl_full:<YMD> iz union-a,
// bez eksternih API poziva. Best-effort filtriranje po leagueId
// koristi KV pipeline (kvPipeline), jer kvMGet ne postoji u lib/kv-read.

import * as s from "../../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// Opcioni: hard blacklist liga po ID-u (dopuni po želji)
const BLOCKED_LEAGUE_IDS = [
  // npr: 128, 71,
];

function ymdNow() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function sanitizeYmd(v){
  const sVal = decodeURIComponent(String(v || "")).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(sVal) ? sVal : ymdNow();
}
function detectSlot(){
  const h = Number(new Date(new Date().toLocaleString("en-US", { timeZone: TZ })).getHours());
  if (h < 10) return "late";
  if (h < 15) return "am";
  return "pm";
}
function sanitizeSlot(v){
  const sVal = decodeURIComponent(String(v || "")).trim().toLowerCase();
  return /^(am|pm|late)$/.test(sVal) ? sVal : detectSlot();
}
function uniqueIds(arr) {
  const seen = new Set(), out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const id = typeof v === "number" ? v : v?.id;
    if (typeof id === "number" && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

// Best-effort čitanje fixture meta iz KV, bez AF poziva
async function readFixturesMeta(ids) {
  if (!ids?.length) return new Map();
  const cmds = ids.map(id => ["GET", `vb:fixture:${id}`]);
  let resp = null;
  try { resp = await s.kvPipeline(cmds); } catch { resp = null; }
  const map = new Map();
  if (Array.isArray(resp)) {
    ids.forEach((id, i) => {
      const v = resp[i]?.result ?? null;
      if (v && typeof v === "object") map.set(id, v);
    });
  }
  return map;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const ymd  = sanitizeYmd(req.query.ymd);
    const slot = sanitizeSlot(req.query.slot);

    // 1) Učitaj union za dan
    const union = await s.kvGet(`vb:day:${ymd}:union`) || [];
    let ids = uniqueIds(union);

    // 2) (Opc.) filtriraj po BLOCKED_LEAGUE_IDS koristeći keširane meta podatke (bez AF)
    if (BLOCKED_LEAGUE_IDS.length && ids.length) {
      const meta = await readFixturesMeta(ids);
      ids = ids.filter(id => {
        const r = meta.get(id);
        const leagueId = r?.leagueId ?? r?.league?.id;
        if (typeof leagueId === "number" && BLOCKED_LEAGUE_IDS.includes(leagueId)) return false;
        return true;
      });
    }

    // 3) Zapiši slot i dnevnu listu
    await s.kvSet(`vbl_full:${ymd}:${slot}`, ids);
    await s.kvSet(`vbl_full:${ymd}`, ids);

    // 4) Istorija (radi traga)
    await s.kvSet(`vb:history:${ymd}`, { ymd, slot, count: ids.length, ts: new Date().toISOString() });

    return res.status(200).json({
      ok: true, ymd, slot, count: ids.length,
      wrote: {
        vblSlotKey: `vbl_full:${ymd}:${slot}`,
        vblDayKey:  `vbl_full:${ymd}`,
        historyKey: `vb:history:${ymd}`
      }
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
