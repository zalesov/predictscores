// pages/api/football.js
// slim=1 -> vraća proširene kartice (home/away/league/kickoff) do 15 kom, cap-guarded
// legacy (bez slim=1) -> vraća IDs iz vbl_full (kao ranije)

import * as s from "../../lib/kv-read";  // ✅ kompatibilno sa ostatkom koda

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };
const API_HOST = "https://v3.football.api-sports.io";
const API_HINTS = ["api-sports.io", "api-football"];

function ymdFromTZ(tz = TZ) {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function slotByHour(h) { if (h < 12) return "am"; if (h < 17) return "pm"; return "late"; }
function detectSlot(tz = TZ) {
  const h = Number(new Date(new Date().toLocaleString("en-US", { timeZone: tz })).getHours());
  return slotByHour(h);
}
function spentKey(ymd, slot) { return `afc:spent:${ymd}:${slot}`; }
function capFor(slot) { return SLOT_CAPS[slot] ?? 2000; }

// Treat placeholders like "<YMD>" or "%3CYMD%3E" kao missing
function sanitizeYmd(v) {
  const sVal = decodeURIComponent(String(v || "")).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sVal)) return null;
  return sVal;
}
function sanitizeSlot(v) {
  const sVal = decodeURIComponent(String(v || "")).trim().toLowerCase();
  if (!/^(am|pm|late)$/.test(sVal)) return null;
  return sVal;
}

async function countedAF(url, opts, ymd, slot) {
  const u = typeof url === "string" ? url : String(url?.url || url);
  if (!API_HINTS.some(h => u.includes(h))) return fetch(url, opts);
  let spent = 0;
  try { spent = Number((await s.kvGet(spentKey(ymd, slot))) || 0); } catch {}
  if (spent >= capFor(slot)) throw new Error(`CAP_REACHED:${slot}:${spent}/${capFor(slot)}`);
  const resp = await fetch(url, opts);
  try { await s.kvSet(spentKey(ymd, slot), String(spent + 1)); } catch {}
  return resp;
}

async function expandOne(id, { ymd, slot, apiKey }) {
  const url = `${API_HOST}/fixtures?id=${id}&timezone=${encodeURIComponent(TZ)}`;
  const r = await countedAF(url, { headers: { "x-apisports-key": apiKey, "accept": "application/json" } }, ymd, slot);
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
  const apiKey = (keyRaw || "").trim();
  if (!apiKey) return [];
  const tasks = ids.slice(0, 15).map(id => expandOne(id, { ymd, slot, apiKey }).catch(() => null));
  const out = (await Promise.all(tasks)).filter(Boolean);
  return out.filter(x => x && x.home && x.away && x.kickoff);
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const ymd = sanitizeYmd(req.query.ymd) || ymdFromTZ(TZ);
    const slot = sanitizeSlot(req.query.slot) || detectSlot(TZ);
    const slim = String(req.query.slim || "0") === "1";

    if (slim) {
      // locked -> fallback vbl_full
      let locked = [];
      try { locked = await s.kvGet("vb-locked:kv:hit"); } catch { locked = []; }
      if (!Array.isArray(locked) || locked.length === 0) {
        try {
          const vbl = await s.kvGet(`vbl_full:${ymd}:${slot}`);
          locked = Array.isArray(vbl) ? vbl.slice(0, 15) : [];
        } catch { locked = []; }
      }
      const ids = Array.isArray(locked) ? locked.slice(0, 15) : [];

      let games = [];
      try { games = await expandList(ids, { ymd, slot }); } catch { games = []; }

      return res.status(200).json({
        ok: true, ymd, slot,
        count: games.length,
        items: games,   // za UI
        ids,
        key: `vbl_full:${ymd}:${slot}`
      });
    }

    // legacy: samo IDs iz vbl_full (kao ranije)
    let vbl = [];
    try { vbl = await s.kvGet(`vbl_full:${ymd}:${slot}`) || []; } catch { vbl = []; }
    const ids = Array.isArray(vbl) ? vbl : [];
    return res.status(200).json({
      ok: true, ymd, slot,
      count: ids.length,
      key: `vbl_full:${ymd}:${slot}`,
      items: ids
    });
  } catch (e) {
    // Umesto 500, vrati 200 sa porukom – da UI ne “pukne”
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
