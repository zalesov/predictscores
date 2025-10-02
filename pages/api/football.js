// pages/api/football.js
// UVEK prikazuje utakmice bez menjanja fronta.
// - Uvek radi expand do 15 mečeva (više ne zavisi od ?slim=1).
// - Vraća meta (ts, last_odds_refresh) + alias polja (homeTeam, awayTeam, leagueName, start/startTime).
// - Fallback lista: vb-locked:kv:hit -> vbl_full:<ymd>:<slot> -> vbl_full:<ymd> -> vb:day:<ymd>:union
// - Capovi AF: LATE<=1000 / AM<=2000 / PM<=3000 (inkrement posle svakog AF poziva).
// - Nikad 500: u catch vraća { ok:false, error } sa 200, da UI ne padne.

import * as s from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";
const SLOT_CAPS = { am: 2000, pm: 3000, late: 1000 };
const API_HOST = "https://v3.football.api-sports.io";
const API_HINTS = ["api-sports.io", "api-football"];

function ymdNow(tz = TZ) {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function slotByHour(h){ if (h < 12) return "am"; if (h < 17) return "pm"; return "late"; }
function detectSlot(tz = TZ) {
  const h = Number(new Date(new Date().toLocaleString("en-US", { timeZone: tz })).getHours());
  return slotByHour(h);
}
function sanitizeYmd(v) {
  const sVal = decodeURIComponent(String(v || "")).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(sVal) ? sVal : null;
}
function sanitizeSlot(v) {
  const sVal = decodeURIComponent(String(v || "")).trim().toLowerCase();
  return /^(am|pm|late)$/.test(sVal) ? sVal : null;
}
function spentKey(ymd, slot){ return `afc:spent:${ymd}:${slot}`; }
function capFor(slot){ return SLOT_CAPS[slot] ?? 2000; }

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

  const home = row?.teams?.home?.name || null;
  const away = row?.teams?.away?.name || null;
  const league = row?.league?.name || null;
  const kickoff = row?.fixture?.date || null;

  if (!home || !away || !kickoff) return null;

  // Alias polja za maksimalnu kompatibilnost sa UI-jem
  return {
    id,
    home, away, league, kickoff,
    homeTeam: home,
    awayTeam: away,
    leagueName: league,
    start: kickoff,
    startTime: kickoff
  };
}

async function expandList(ids, { ymd, slot }) {
  const keyRaw = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  const apiKey = (keyRaw || "").trim();
  if (!apiKey) return [];
  const tasks = ids.slice(0, 15).map(id => expandOne(id, { ymd, slot, apiKey }).catch(() => null));
  const out = (await Promise.all(tasks)).filter(Boolean);
  return out;
}

async function uniqueList(arr) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const id = typeof v === "number" ? v : v?.id;
    if (typeof id === "number" && !seen.has(id)) {
      seen.add(id); out.push(id);
    }
  }
  return out;
}

async function pickIds(ymd, slot) {
  // 1) locked
  try {
    const locked = await s.kvGet("vb-locked:kv:hit");
    const ids = await uniqueList(locked);
    if (ids.length) return ids;
  } catch {}
  // 2) vbl_full:<ymd>:<slot>
  try {
    const vblSlot = await s.kvGet(`vbl_full:${ymd}:${slot}`);
    const ids = await uniqueList(vblSlot);
    if (ids.length) return ids;
  } catch {}
  // 3) vbl_full:<ymd>
  try {
    const vblDay = await s.kvGet(`vbl_full:${ymd}`);
    const ids = await uniqueList(vblDay);
    if (ids.length) return ids;
  } catch {}
  // 4) vb:day:<ymd>:union
  try {
    const union = await s.kvGet(`vb:day:${ymd}:union`);
    const ids = await uniqueList(union);
    if (ids.length) return ids;
  } catch {}
  return [];
}

async function readMeta(ymd, slot) {
  let meta = null;
  try { meta = await s.kvGet("vb-locked:kv:hit:meta"); } catch {}
  const nowIso = new Date().toISOString();
  return {
    ymd, slot, source: "vb-locked:kv:hit",
    ts: meta?.ts || nowIso,
    last_odds_refresh: meta?.last_odds_refresh || nowIso
  };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const ymd = sanitizeYmd(req.query.ymd) || ymdNow(TZ);
    const slot = sanitizeSlot(req.query.slot) || detectSlot(TZ);

    // 1) Nabavi listu ID-eva iz KV sa fallback lancem
    let ids = await pickIds(ymd, slot);
    ids = ids.slice(0, 15);

    // 2) Expand u detalje (cap-guarded)
    const items = await expandList(ids, { ymd, slot });

    // 3) Meta
    const meta = await readMeta(ymd, slot);
    meta.returned = items.length;
    meta.cap = 15;

    return res.status(200).json({
      ok: true,
      ymd, slot,
      count: items.length,
      items,   // pune kartice + alias polja
      ids,     // fallback lista ID-eva
      meta
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
