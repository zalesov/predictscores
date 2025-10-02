// pages/api/value-bets-locked.js
// Uvek vraća popunjene utakmice da frontend ne ostane bez kartica.
// - Čita locked listu + meta; koristi postojeće `games` kao cache (bez dodatnih AF poziva za te stavke).
// - Fallback na vbl_full:<ymd>:<slot> -> vbl_full:<ymd> -> vb:day:<ymd>:union.
// - Expanduje samo ono što nema detalje (max 15); poštuje per-slot limitere (late≤1000 / am≤2000 / pm≤3000).
// - Vraća items (puni), games (isti kao items), ids, meta (ts/last_odds_refresh), returned, cap.
// - Nikad 500: greške vraća kao ok:false sa 200.

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
function detectSlot(tz = TZ){
  const h = Number(new Date(new Date().toLocaleString("en-US", { timeZone: tz })).getHours());
  return slotByHour(h);
}
function sanitizeYmd(v){
  const sVal = decodeURIComponent(String(v || "")).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(sVal) ? sVal : null;
}
function sanitizeSlot(v){
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

function normalizeOne(row, id) {
  if (!row) return null;
  const home = row.home || row.homeTeam || row?.teams?.home?.name || null;
  const away = row.away || row.awayTeam || row?.teams?.away?.name || null;
  const league = row.league || row.leagueName || row?.league?.name || null;
  const kickoff = row.kickoff || row.start || row.startTime || row?.fixture?.date || null;
  if (!home || !away || !kickoff) return null;
  return {
    id: id ?? row.id,
    home, away, league, kickoff,
    homeTeam: home,
    awayTeam: away,
    leagueName: league,
    start: kickoff,
    startTime: kickoff,
  };
}

async function expandOne(id, { ymd, slot, apiKey }) {
  const url = `${API_HOST}/fixtures?id=${id}&timezone=${encodeURIComponent(TZ)}`;
  const r = await countedAF(url, { headers: { "x-apisports-key": apiKey, "accept": "application/json" } }, ymd, slot);
  const data = await r.json();
  if (data?.errors && Object.keys(data.errors).length > 0) return null;
  const row = Array.isArray(data?.response) ? data.response[0] : null;
  if (!row) return null;
  return normalizeOne({
    id,
    home: row?.teams?.home?.name,
    away: row?.teams?.away?.name,
    league: row?.league?.name,
    kickoff: row?.fixture?.date,
  }, id);
}

async function expandMissing(ids, haveMap, { ymd, slot }) {
  const keyRaw = process.env.API_FOOTBALL_KEY || process.env.NEXT_PUBLIC_API_FOOTBALL_KEY;
  const apiKey = (keyRaw || "").trim();
  if (!apiKey) return [];

  const need = ids.filter(id => !haveMap.has(id)).slice(0, Math.max(0, 15 - haveMap.size));
  const tasks = need.map(id => expandOne(id, { ymd, slot, apiKey }).catch(() => null));
  const out = (await Promise.all(tasks)).filter(Boolean);
  return out;
}

async function uniqueIdList(arr) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const id = typeof v === "number" ? v : v?.id;
    if (typeof id === "number" && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

async function pickIds(ymd, slot) {
  // 1) locked list
  try {
    const locked = await s.kvGet("vb-locked:kv:hit");
    const ids = await uniqueIdList(locked);
    if (ids.length) return ids;
  } catch {}
  // 2) vbl_full:<ymd>:<slot>
  try {
    const vblSlot = await s.kvGet(`vbl_full:${ymd}:${slot}`);
    const ids = await uniqueIdList(vblSlot);
    if (ids.length) return ids;
  } catch {}
  // 3) vbl_full:<ymd>
  try {
    const vblDay = await s.kvGet(`vbl_full:${ymd}`);
    const ids = await uniqueIdList(vblDay);
    if (ids.length) return ids;
  } catch {}
  // 4) union
  try {
    const union = await s.kvGet(`vb:day:${ymd}:union`);
    const ids = await uniqueIdList(union);
    if (ids.length) return ids;
  } catch {}
  return [];
}

async function readLockedMeta(ymd, slot) {
  let meta = null;
  try { meta = await s.kvGet("vb-locked:kv:hit:meta"); } catch {}
  const nowIso = new Date().toISOString();
  return {
    ymd, slot,
    source: "vb-locked:kv:hit",
    ts: meta?.ts || nowIso,
    last_odds_refresh: meta?.last_odds_refresh || nowIso
  };
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");

    const ymd = sanitizeYmd(req.query.ymd) || ymdNow(TZ);
    const slot = sanitizeSlot(req.query.slot) || detectSlot(TZ);

    // 1) Locked payload (možemo iskoristiti `games` kao keš detalja)
    let lockedRaw = [];
    try { lockedRaw = await s.kvGet("vb-locked:kv:hit") || []; } catch {}
    let lockedGames = [];
    try {
      const metaGames = await s.kvGet(`vb-locked:kv:hit:games`) || [];
      lockedGames = Array.isArray(metaGames) ? metaGames : [];
    } catch {}

    // Ako u lockedRaw ima objekata sa home/away, iskoristi i to:
    const seeds = [];
    for (const it of Array.isArray(lockedRaw) ? lockedRaw : []) {
      const obj = normalizeOne(it, it?.id ?? (typeof it === "number" ? it : null));
      if (obj) seeds.push(obj);
    }
    // + "games" iz locked storage (ako postoji):
    for (const g of Array.isArray(lockedGames) ? lockedGames : []) {
      const obj = normalizeOne(g, g?.id);
      if (obj) seeds.push(obj);
    }

    // 2) Lista ID-eva (fallback lanac)
    let ids = await uniqueIdList(lockedRaw);
    if (ids.length === 0) ids = await pickIds(ymd, slot);
    ids = ids.slice(0, 15);

    // 3) Mapiraj seed detalje po id, expanduj samo ono što fali
    const haveMap = new Map(seeds.map(x => [x.id, x]));
    const expanded = await expandMissing(ids, haveMap, { ymd, slot });
    for (const e of expanded) haveMap.set(e.id, e);

    const items = ids.map(id => haveMap.get(id)).filter(Boolean);

    // 4) Meta + shape kompatibilan sa UI-jem
    const meta = await readLockedMeta(ymd, slot);
    meta.returned = items.length;
    meta.cap = 15;

    return res.status(200).json({
      items,                  // uvek popunjene stavke
      ids,                    // referentna ID lista
      games: items,           // zadržavamo i "games" za kompatibilnost
      meta
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
