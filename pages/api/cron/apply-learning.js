// pages/api/cron/apply-learning.js
// Formira vbl_full:<YMD>:<slot> i vbl_full:<YMD> iz union-a,
// bez lomljenja: ne menja shape, samo doda lake filtre gde ima meta.
// Blacklist po ID-u liga će biti strogo primenjena u refresh-odds/value-bets-locked.

import * as s from "../../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const SLOT_CAPS = { late: 1000, am: 2000, pm: 3000 };

// Opcioni: hard blacklist liga po ID-u (popuni po želji)
const BLOCKED_LEAGUE_IDS = [
  // npr: 128, 71, ...
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
function sanitizeSlot(v){
  const sVal = decodeURIComponent(String(v || "")).trim().toLowerCase();
  return /^(am|pm|late)$/.test(sVal) ? sVal : detectSlot();
}
function detectSlot(){
  const h = Number(new Date(new Date().toLocaleString("en-US", { timeZone: TZ })).getHours());
  if (h < 10) return "late";
  if (h < 15) return "am";
  return "pm";
}

function uniqueIds(arr) {
  const seen = new Set(), out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const id = typeof v === "number" ? v : v?.id;
    if (typeof id === "number" && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const ymd = sanitizeYmd(req.query.ymd);
    const slot = sanitizeSlot(req.query.slot);

    // 1) Učitaj union za dan
    const union = await s.kvGet(`vb:day:${ymd}:union`) || [];
    let ids = uniqueIds(union);

    // 2) (Opc.) Ako postoje već keširani detalji u KV po ID-u sa leagueId, isključi blokirane lige
    // Ovo je "best effort" – ne troši AF cap. Glavni, strogi filter je u refresh-odds.
    const detailed = await s.kvMGet(ids.map(id => `vb:fixture:${id}`).filter(Boolean)).catch(() => null);
    if (Array.isArray(detailed) && detailed.length) {
      const map = new Map();
      for (let i = 0; i < detailed.length; i++) {
        const row = detailed[i];
        if (row && typeof row === "object" && typeof row.id === "number") {
          map.set(row.id, row);
        }
      }
      ids = ids.filter(id => {
        const r = map.get(id);
        const leagueId = r?.league?.id ?? r?.leagueId;
        if (typeof leagueId === "number" && BLOCKED_LEAGUE_IDS.includes(leagueId)) return false;
        return true;
      });
    }

    // 3) Zapiši slot listu i dnevnu listu (learning heuristike možeš proširiti kasnije)
    await s.kvSet(`vbl_full:${ymd}:${slot}`, ids);
    await s.kvSet(`vbl_full:${ymd}`, ids);

    await s.kvSet(`vb:history:${ymd}`, { ymd, slot, count: ids.length, ts: new Date().toISOString() });

    return res.status(200).json({
      ok: true, ymd, slot, count: ids.length,
      wrote: {
        vblSlotKey: `vbl_full:${ymd}:${slot}`,
        vblDayKey: `vbl_full:${ymd}`,
        historyKey: `vb:history:${ymd}`
      }
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
