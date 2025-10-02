// pages/api/value-bets-locked.js
// Vraća do 15 mečeva za slot: pune kartice + (ako postoje) odds/edge.
// Ako nema games u locked feedu, dopunjava detalje iz vb:fixture:<id> (KV keš).
// Uklanja Reserve/U/W lige i poštuje slot prozore. Nema eksternih API poziva.

import * as s from "../../lib/kv-read";

export const config = { api: { bodyParser: false } };

const TZ = process.env.TZ_DISPLAY || "Europe/Belgrade";

// Hard blacklist po league ID-u (opciono)
const BLOCKED_LEAGUE_IDS = [
  // npr: 128, 71,
];

// Regex blokovi po nazivu lige
const RE_YOUTH = /\bU(?:23|22|21|20|19|18|17|16|15)\b/i;
const RE_YOUTH_WORDS = /\b(under\s?(?:23|22|21|20|19|18|17|16|15)|primavera|youth|junior[es]?|sub\s?(?:23|22|21|20|19|18|17|16|15))\b/i;
const RE_RESERVE = /\b(reserve|res\.|reserves)\b/i;
const RE_WOMEN = new RegExp([
  "\\bwomen'?s?\\b", "\\bfemeni\\w*\\b", "\\blad(?:y|ies)\\b",
  "(?<!world)\\sW(\\s|\\b|[-)]|$)", "\\bW-?league\\b", "\\bW\\.?\\s?cup\\b"
].join("|"), "i");

function sval(x){ return (x==null) ? "" : String(x); }
function isBlockedLeagueName(nameRaw){
  const name = sval(nameRaw).trim();
  if (!name) return false;
  if (RE_WOMEN.test(name)) return true;
  if (RE_YOUTH.test(name) || RE_YOUTH_WORDS.test(name)) return true;
  if (RE_RESERVE.test(name)) return true;
  return false;
}

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
function hourFromIsoLocal(iso) {
  if (typeof iso !== "string") return null;
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}
function inSlotWindow(kickoffIso, slot) {
  const h = hourFromIsoLocal(kickoffIso);
  if (h == null) return false;
  if (slot === "late") return h >= 0 && h < 10;
  if (slot === "am")   return h >= 10 && h < 15;
  if (slot === "pm")   return h >= 15 && h <= 23;
  return true;
}
function uniqueIds(arr) {
  const seen = new Set(), out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const id = typeof v === "number" ? v : v?.id;
    if (typeof id === "number" && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}

// Batch: pročitaj odds iz KV
async function readOddsBulk(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cmds = ids.map(id => ["GET", `vb-odds:last:${id}`]);
  let resp = null;
  try { resp = await s.kvPipeline(cmds); } catch { resp = null; }
  if (Array.isArray(resp)) {
    ids.forEach((id, i) => out.set(id, resp[i]?.result ?? null));
  }
  return out;
}

// Batch: pročitaj fixture meta (home/away/league/kickoff) iz KV
async function readFixturesBulk(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const cmds = ids.map(id => ["GET", `vb:fixture:${id}`]);
  let resp = null;
  try { resp = await s.kvPipeline(cmds); } catch { resp = null; }
  if (Array.isArray(resp)) {
    ids.forEach((id, i) => {
      const v = resp[i]?.result ?? null;
      if (v && typeof v === "object") out.set(id, v);
    });
  }
  return out;
}

export default async function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const ymd  = sanitizeYmd(req.query.ymd);
    const slot = sanitizeSlot(req.query.slot);

    // 1) Probaj locked games (pune stavke)
    let games = [];
    try {
      const g = await s.kvGet("vb-locked:kv:hit:games");
      if (Array.isArray(g)) games = g;
    } catch {}

    // 2) Ako nema punih stavki, uzmi ID listu pa dopuni detalje iz vb:fixture:<id>
    let ids = [];
    if (!games.length) {
      try { ids = uniqueIds(await s.kvGet("vb-locked:kv:hit") || []); } catch { ids = []; }
      if (!ids.length) {
        // fallback lanac
        const chain = [`vbl_full:${ymd}:${slot}`, `vbl_full:${ymd}`, `vb:day:${ymd}:union`];
        for (const k of chain) {
          try {
            const v = await s.kvGet(k);
            ids = uniqueIds(v);
            if (ids.length) break;
          } catch {}
        }
      }
      if (ids.length) {
        const fixMap = await readFixturesBulk(ids);
        games = ids.map(id => {
          const v = fixMap.get(id) || {};
          return {
            id,
            home: v.home ?? v.homeTeam ?? null,
            away: v.away ?? v.awayTeam ?? null,
            league: v.leagueName ?? v.league ?? null,
            leagueId: v.leagueId ?? (v.league && v.league.id) ?? null,
            kickoff: v.kickoff ?? v.start ?? v.startTime ?? null,
            homeTeam: v.home ?? v.homeTeam ?? null,
            awayTeam: v.away ?? v.awayTeam ?? null,
            leagueName: v.leagueName ?? v.league ?? null,
            start: v.kickoff ?? v.start ?? v.startTime ?? null,
            startTime: v.kickoff ?? v.start ?? v.startTime ?? null
          };
        });
      }
    }

    // 3) Filtriraj po slot prozoru + liga blokovi
    games = games.filter(g => {
      const league = g.leagueName ?? g.league ?? null;
      if (league && isBlockedLeagueName(league)) return false;
      const lid = g.leagueId;
      if (typeof lid === "number" && BLOCKED_LEAGUE_IDS.includes(lid)) return false;
      if (g.kickoff && !inSlotWindow(g.kickoff, slot)) return false;
      return true;
    });

    // 4) Odds iz KV (bez AF) + sort po kickoff
    const oddsMap = await readOddsBulk(games.map(g => g.id));
    games.sort((a,b)=> String(a.kickoff||"").localeCompare(String(b.kickoff||"")));

    // 5) Finalnih do 15
    const picked = games.slice(0, 15).map(g => {
      const odds = oddsMap.get(g.id) ?? null;
      const obj = {
        id: g.id, leagueId: (typeof g.leagueId === "number") ? g.leagueId : null,
        home: g.home ?? g.homeTeam ?? undefined,
        away: g.away ?? g.awayTeam ?? undefined,
        league: g.league ?? g.leagueName ?? undefined,
        kickoff: g.kickoff ?? g.start ?? g.startTime ?? undefined,
        homeTeam: g.home ?? g.homeTeam ?? undefined,
        awayTeam: g.away ?? g.awayTeam ?? undefined,
        leagueName: g.league ?? g.leagueName ?? undefined,
        start: g.kickoff ?? g.start ?? g.startTime ?? undefined,
        startTime: g.kickoff ?? g.start ?? g.startTime ?? undefined
      };
      if (odds) obj.odds = odds;
      return obj;
    });

    // 6) Meta
    const metaRaw = await s.kvGet("vb-locked:kv:hit:meta").catch(()=>null);
    const nowIso = new Date().toISOString();
    const meta = {
      ymd, slot, source:"vb-locked:kv:hit",
      ts: metaRaw?.ts || nowIso,
      last_odds_refresh: metaRaw?.last_odds_refresh || nowIso,
      returned: picked.length, cap: 15,
      fallback_used: false
    };

    return res.status(200).json({
      items: picked,
      ids: picked.map(x => x.id),
      games: picked,
      meta
    });
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
}
